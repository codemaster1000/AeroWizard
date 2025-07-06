require('dotenv').config();
console.log('TELEGRAM_BOT_TOKEN is set:', !!process.env.TELEGRAM_BOT_TOKEN);

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const setupCronEndpoints = require('./cron-endpoints');

// Import our modules
const FlightAPI = require('./services/flightAPI');
const FirebaseService = require('./services/database');
const PriceMonitor = require('./services/priceMonitor');
const FlightTracker = require('./services/flightTracker');

// Initialize Express app
const app = express();
app.use(express.json());

// User state management
const userStates = new Map();

// Initialize services
const flightAPI = new FlightAPI();
const firebaseService = new FirebaseService();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: process.env.NODE_ENV !== 'production' });
const priceMonitor = new PriceMonitor(bot, flightAPI, firebaseService, userStates);
const flightTracker = new FlightTracker(bot, flightAPI, firebaseService, userStates);

// Expose handleMyAlerts function globally for use in priceMonitor.js
global.handleMyAlerts = handleMyAlerts;

// ==========================================
// Core Functionality
// ==========================================

// Initialize API and database
async function initialize() {
    try {
        // Initialize database
        await firebaseService.initialize();
        console.log('Database initialized successfully');

        // Test API connection
        await flightAPI.getAccessToken();
        console.log("Initial API authentication successful");

        const apiHealthy = await flightAPI.checkApiHealth();
        if (!apiHealthy) {
            console.warn("API health check failed, but continuing...");
        }
    } catch (error) {
        console.error('Initialization error:', error);
        process.exit(1);
    }
}

// Function to map airline names to codes
async function findAirlineCode(airlineName) {
    // Map of common airline names to codes
    const commonAirlines = {
        'american': 'AA',
        'united': 'UA',
        'delta': 'DL',
        'southwest': 'WN',
        'lufthansa': 'LH',
        'air france': 'AF',
        'british airways': 'BA',
        'emirates': 'EK',
        'qatar': 'QR',
        'singapore': 'SQ',
        'air india': 'AI',
        'indigo': '6E',
        'vistara': 'UK',
        'spicejet': 'SG',
        'air canada': 'AC',
        'klm': 'KL',
        'turkish': 'TK',
        'jetblue': 'B6'
    };

    // Normalize input
    const normalizedName = airlineName.toLowerCase().trim();

    // Check if input is already a valid airline code (2 characters)
    if (normalizedName.length === 2 && /^[A-Za-z0-9]{2}$/.test(normalizedName)) {
        return normalizedName.toUpperCase();
    }

    // Try to get exact match
    if (commonAirlines[normalizedName]) {
        return commonAirlines[normalizedName];
    }

    // Try to get partial match with more strict conditions
    for (const [name, code] of Object.entries(commonAirlines)) {
        // Only match if the input is a substantial part of the airline name
        // This prevents "ai" from matching with "air france"
        if (name.includes(normalizedName) && normalizedName.length > 2) {
            return code;
        }
    }

    // If no match, return the original input (it might be the code already)
    return airlineName.toUpperCase();
}

// Handler for my alerts menu
async function handleMyAlerts(chatId, userId) {
    try {
        const alerts = await firebaseService.getUserAlerts(userId);

        if (alerts.length === 0) {
            bot.sendMessage(chatId, '📭 You have no active flight alerts. Use the "🔍 Search Flights" button to create one!');
            return;
        }

        let message = '✈️ Your Active Flight Alerts:\n\n';
        const inlineKeyboard = [];

        alerts.forEach((alert, index) => {
            message += `${index + 1}. ${alert.origin} → ${alert.destination}\n`;
            message += `   📅 ${alert.departure_date}\n`;
            message += `   💰 ${alert.min_price > 0 ? `Target: $${alert.min_price} | ` : ''}Current: $${alert.current_price || 'Checking...'}\n`;
            message += `   🆔 Alert ID: ${alert.alert_id}\n\n`;

            inlineKeyboard.push([
                { text: `📊 History (#${index + 1})`, callback_data: `history_${alert.alert_id}` },
                { text: `❌ Cancel (#${index + 1})`, callback_data: `cancel_${alert.alert_id}` }
            ]);
        });

        inlineKeyboard.push([{ text: '🔍 Search New Flights', callback_data: 'search_new' }]);

        await bot.sendMessage(chatId, message, {
            reply_markup: { inline_keyboard: inlineKeyboard }
        });
    } catch (error) {
        console.error('Error fetching alerts:', error);
        bot.sendMessage(chatId, '❌ Error fetching your alerts. Please try again.');
    }
}

// Function for handling conversation flow
async function processConversationStep(msg) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text;
    const userState = userStates.get(userId);

    if (!userState) return;

    console.log(`Processing step ${userState.step} for user ${userId}, input: "${text.substring(0, 20)}..."`);

    try {
        // Flight search conversation flow
        if (userState.step === 'search_origin') {
            // Store the original text input by user
            userState.data.originText = text;

            // Find matching airports for the input city name
            try {
                const airports = await flightAPI.findAirports(text);

                if (airports.length === 0) {
                    await bot.sendMessage(chatId, '❌ No airports found for this city. Please try another city name.');
                    return;
                } else if (airports.length === 1) {
                    // Only one airport found, use it directly
                    userState.data.origin = airports[0].code;
                    userState.data.originName = airports[0].name;
                    userState.step = 'search_destination';
                    userStates.set(userId, userState);

                    await bot.sendMessage(chatId,
                        `✅ Selected departure: ${airports[0].name} (${airports[0].code})
                
🎯 Which city are you flying TO?`);
                    return;
                } else {
                    // Multiple airports found, show options
                    userState.step = 'select_origin_airport';
                    userState.data.airports = airports;
                    userStates.set(userId, userState);

                    const keyboard = {
                        inline_keyboard: airports.map((airport, index) => {
                            return [{
                                text: `${airport.name} (${airport.code})`,
                                callback_data: `origin_${index}`
                            }];
                        })
                    };

                    await bot.sendMessage(chatId, '🛫 Multiple airports found. Please select your departure airport:', {
                        reply_markup: keyboard
                    });
                    return;
                }
            } catch (error) {
                console.error('Error finding airports:', error);
                await bot.sendMessage(chatId, '❌ Error finding airports. Please try again with a different city name.');
                return;
            }
        }

        if (userState.step === 'search_destination') {
            // Store the original text input by user
            userState.data.destinationText = text;

            // Find matching airports for the input city name
            try {
                const airports = await flightAPI.findAirports(text);

                if (airports.length === 0) {
                    await bot.sendMessage(chatId, '❌ No airports found for this city. Please try another city name.');
                    return;
                } else if (airports.length === 1) {
                    // Only one airport found, use it directly
                    userState.data.destination = airports[0].code;
                    userState.data.destinationName = airports[0].name;
                    userState.step = 'search_departure_date';
                    userStates.set(userId, userState);

                    await bot.sendMessage(chatId,
                        `✅ Selected destination: ${airports[0].name} (${airports[0].code})
                
📅 What's your departure date? (YYYY-MM-DD format, e.g., 2024-12-25)`);
                    return;
                } else {
                    // Multiple airports found, show options
                    userState.step = 'select_destination_airport';
                    userState.data.airports = airports;
                    userStates.set(userId, userState);

                    const keyboard = {
                        inline_keyboard: airports.map((airport, index) => {
                            return [{
                                text: `${airport.name} (${airport.code})`,
                                callback_data: `dest_${index}`
                            }];
                        })
                    };

                    await bot.sendMessage(chatId, '🛬 Multiple airports found. Please select your destination airport:', {
                        reply_markup: keyboard
                    });
                    return;
                }
            } catch (error) {
                console.error('Error finding airports:', error);
                await bot.sendMessage(chatId, '❌ Error finding airports. Please try again with a different city name.');
                return;
            }
        }

        if (userState.step === 'search_departure_date') {
            const formattedDate = formatDate(text);
            if (!formattedDate) {
                bot.sendMessage(chatId, '❌ Please use a valid date format (e.g., YYYY-MM-DD, DD-MM-YYYY, DD-MM-YY)');
                return;
            }

            // Validate date logic
            if (!isValidFutureDate(formattedDate)) {
                bot.sendMessage(chatId, '❌ Please enter a future date.');
                return;
            }

            userState.data.departure_date = formattedDate;
            userState.step = 'search_return_date';
            userStates.set(userId, userState);
            bot.sendMessage(chatId, '🔄 Return date? (Same format as departure date, or type "oneway" for one-way flight)');
            return;
        }

        if (userState.step === 'search_return_date') {
            let returnDate = null;

            if (text.toLowerCase() !== 'oneway') {
                returnDate = formatDate(text);
                if (!returnDate) {
                    bot.sendMessage(chatId, '❌ Please use a valid date format or type "oneway"');
                    return;
                }

                // Check return date is after departure
                if (!isReturnDateValid(userState.data.departure_date, returnDate)) {
                    bot.sendMessage(chatId, '❌ Return date must be after departure date.');
                    return;
                }
            }

            userState.data.return_date = returnDate;
            userStates.set(userId, userState);

            // Search flights
            await searchFlightsForUser(chatId, userId);
            return;
        }

        // Handle tracking method selection
        if (userState.step === 'track_flight_method') {
            if (text === 'Search by Route') {
                userState.step = 'track_flight_origin';
                userState.data.trackingMethod = 'route';
                userStates.set(userId, userState);
                await bot.sendMessage(chatId, '🏠 Which city are you flying FROM? (e.g., NYC, London, Delhi)');
                return;
            }
            else if (text === 'Search by Flight Number') {
                userState.step = 'track_flight_airline';
                userState.data.trackingMethod = 'flight_number';
                userStates.set(userId, userState);
                await bot.sendMessage(chatId, '✈️ Enter airline name or code (e.g., "American" or "AA"):');
                return;
            }
            // If we get here, it's an invalid choice
            await bot.sendMessage(chatId, '❌ Please select one of the provided options.');
            return;
        }

        // Flight tracking conversation flow - By Route method
        if (userState.step === 'track_flight_origin') {
            try {
                const airports = await flightAPI.findAirports(text);

                if (airports.length === 0) {
                    await bot.sendMessage(chatId, '❌ No airports found for this city. Please try another city name.');
                    return;
                } else {
                    // Always select the first airport from the list (even if there are multiple)
                    const selectedAirport = airports[0];
                    userState.data.origin = selectedAirport.code;
                    userState.data.originName = selectedAirport.name;
                    userState.step = 'track_flight_destination';
                    userStates.set(userId, userState);

                    await bot.sendMessage(chatId,
                        `✅ Selected departure: ${selectedAirport.name} (${selectedAirport.code})
                
🎯 Which city are you flying TO?`);
                    return;
                }
            } catch (error) {
                console.error('Error finding airports:', error);
                await bot.sendMessage(chatId, '❌ Error finding airports. Please try again with a different city name.');
                return;
            }
        }

        if (userState.step === 'track_flight_destination') {
            try {
                const airports = await flightAPI.findAirports(text);

                if (airports.length === 0) {
                    await bot.sendMessage(chatId, '❌ No airports found for this city. Please try another city name.');
                    return;
                } else {
                    // Always select the first airport from the list (even if there are multiple)
                    const selectedAirport = airports[0];
                    userState.data.destination = selectedAirport.code;
                    userState.data.destinationName = selectedAirport.name;
                    userState.step = 'track_flight_date';
                    userStates.set(userId, userState);

                    await bot.sendMessage(chatId,
                        `✅ Selected destination: ${selectedAirport.name} (${selectedAirport.code})
                
📅 What's your departure date? (YYYY-MM-DD format, e.g., 2024-12-25)`);
                    return;
                }
            } catch (error) {
                console.error('Error finding airports:', error);
                await bot.sendMessage(chatId, '❌ Error finding airports. Please try again with a different city name.');
                return;
            }
        }

        // Flight tracking by flight number
        if (userState.step === 'track_flight_airline') {
            const airlineCode = await findAirlineCode(text);
            userState.data.carrierCode = airlineCode;
            userState.step = 'track_flight_number';
            userStates.set(userId, userState);
            bot.sendMessage(chatId, `✅ Airline code: ${airlineCode}\n\n📝 Please enter the flight number (digits only, e.g., 123):`);
            return;
        }

        if (userState.step === 'track_flight_number') {
            // Validate flight number (only digits)
            if (!/^\d+$/.test(text)) {
                bot.sendMessage(chatId, '❌ Please enter only digits for the flight number (e.g., 123)');
                return;
            }

            userState.data.flightNumber = text;
            userState.step = 'track_flight_date';
            userStates.set(userId, userState);
            bot.sendMessage(chatId, '📅 What\'s the flight date? (YYYY-MM-DD format, e.g., 2024-12-25)');
            return;
        }

        if (userState.step === 'track_flight_date') {
            const formattedDate = formatDate(text);
            if (!formattedDate) {
                bot.sendMessage(chatId, '❌ Please use a valid date format (YYYY-MM-DD)');
                return;
            }

            // Validate date
            if (!isValidFutureDate(formattedDate)) {
                bot.sendMessage(chatId, '❌ Please enter a future date within the next 330 days.');
                return;
            }

            userState.data.date = formattedDate;

            // Different flow based on tracking method
            if (userState.data.trackingMethod === 'route') {
                // We have origin, destination, and date - search for flights now
                try {
                    // Create new variables to ensure we're using string values
                    const originCode = String(userState.data.origin || '');
                    const destinationCode = String(userState.data.destination || '');

                    // Additional validation with better error handling
                    if (!originCode || originCode === 'origin' || originCode.length !== 3) {
                        console.error(`Invalid origin code: "${originCode}" (type: ${typeof originCode})`);
                        bot.sendMessage(chatId, '❌ Invalid origin airport code. Please restart tracking.');
                        userStates.delete(userId);
                        return;
                    }

                    if (!destinationCode || destinationCode === 'destination' || destinationCode.length !== 3) {
                        console.error(`Invalid destination code: "${destinationCode}" (type: ${typeof destinationCode})`);
                        bot.sendMessage(chatId, '❌ Invalid destination airport code. Please restart tracking.');
                        userStates.delete(userId);
                        return;
                    }

                    bot.sendMessage(chatId, `🔍 Searching for flights from ${originCode} to ${destinationCode} on ${formattedDate}... Hold on.`);
                    console.log(`Final API call parameters: origin=${originCode} (${typeof originCode}), destination=${destinationCode} (${typeof destinationCode}), date=${formattedDate}`);

                    // Use the validated values for the API call
                    const flights = await flightAPI.searchFlights(
                        originCode,
                        destinationCode,
                        formattedDate
                    );

                    if (!flights || flights.length === 0) {
                        // IMPORTANT: First delete the user state before sending the message
                        userStates.delete(userId);

                        // THEN send message with main menu keyboard
                        bot.sendMessage(chatId, '❌ No flights found for this route and date. Please try a different date or route.', {
                            reply_markup: {
                                keyboard: [
                                    [{ text: '🔍 Search Flights' }],
                                    [{ text: '💰 My Price Alerts' }, { text: '✈️ My Tracked Flights' }],
                                    [{ text: '🛫 Track Flights' }, { text: '❓ Help' }],
                                    [{ text: '⭐ Premium' }, { text: '🔗 Share' }]
                                ],
                                resize_keyboard: true,
                                persistent: true
                            }
                        });
                        return;
                    }

                    // Show available flights for tracking
                    let message = `✅ Found ${flights.length} flights from ${userState.data.origin} to ${userState.data.destination} on ${formattedDate}.\n\n`;
                    message += 'Please select a flight to track:\n\n';

                    const keyboard = { inline_keyboard: [] };

                    // Show first 10 flights max
                    const maxFlights = Math.min(flights.length, 10);
                    for (let i = 0; i < maxFlights; i++) {
                        const flight = flights[i];
                        const segment = flight.segments?.[0];
                        if (!segment) continue;

                        const departureTime = new Date(segment.departure?.at).toLocaleTimeString('en-US', {
                            hour: '2-digit', minute: '2-digit', hour12: false
                        });

                        const arrivalTime = new Date(segment.arrival?.at).toLocaleTimeString('en-US', {
                            hour: '2-digit', minute: '2-digit', hour12: false
                        });

                        message += `${i + 1}. ${segment.carrierCode}${segment.flightNumber} - ${departureTime} → ${arrivalTime}\n`;

                        keyboard.inline_keyboard.push([{
                            text: `${i + 1}. ${segment.carrierCode}${segment.flightNumber} at ${departureTime}`,
                            callback_data: `select_flight_${i}`
                        }]);
                    }

                    // Store flights in user state
                    userState.data.flights = flights;
                    userState.step = 'select_flight_to_track';
                    userStates.set(userId, userState);

                    bot.sendMessage(chatId, message, { reply_markup: keyboard });
                } catch (error) {
                    console.error('Error searching flights:', error);
                    bot.sendMessage(chatId, '❌ Error searching flights. Please try again later.');
                }
            } else {
                // We have carrier code, flight number and date - try to verify this flight exists
                try {
                    bot.sendMessage(chatId, `🔍 Checking flight ${userState.data.carrierCode}${userState.data.flightNumber} on ${formattedDate}...`);

                    // Verify flight exists
                    const flightStatus = await flightTracker.getFlightStatus(
                        userState.data.carrierCode,
                        userState.data.flightNumber,
                        formattedDate
                    );

                    if (!flightStatus) {
                        // IMPORTANT: Clear user state first
                        userStates.delete(userId);

                        // THEN send error message with main menu keyboard
                        bot.sendMessage(chatId, '❌ Flight not found. Please check the airline, flight number, and date.', {
                            reply_markup: {
                                keyboard: [
                                    [{ text: '🔍 Search Flights' }],
                                    [{ text: '💰 My Price Alerts' }, { text: '✈️ My Tracked Flights' }],
                                    [{ text: '🛫 Track Flights' }, { text: '❓ Help' }],
                                    [{ text: '⭐ Premium' }, { text: '🔗 Share' }]
                                ],
                                resize_keyboard: true,
                                persistent: true
                            }
                        });
                        return;
                    }

                    // Create the track
                    await flightTracker.createFlightTrack(chatId, userId, {
                        carrierCode: userState.data.carrierCode,
                        flightNumber: userState.data.flightNumber,
                        date: userState.data.date,
                        origin: flightStatus.departureAirport,
                        destination: flightStatus.arrivalAirport
                    });

                    // Clear user state
                    userStates.delete(userId);

                    // REMOVE THIS PART - Don't send the "Returned to main menu" message
                    // Just silently return to the main menu keyboard

                    // The user will now be back at the main menu automatically
                } catch (error) {
                    console.error('Error verifying flight:', error);
                    bot.sendMessage(chatId, '❌ Error checking flight. Please verify your flight details and try again.');
                }
            }
            return;
        }

        // Flight tracking conversation flow
        switch (userState.step) {
            case 'track_origin':
                userState.data.origin = text;
                userState.step = 'track_destination';
                userStates.set(userId, userState);
                bot.sendMessage(chatId, '🎯 Which city are you flying TO? (e.g., NYC, London, Delhi)');
                break;

            case 'track_destination':
                userState.data.destination = text;
                userState.step = 'track_departure_date';
                userStates.set(userId, userState);
                bot.sendMessage(chatId, '📅 What\'s your departure date? (YYYY-MM-DD format, e.g., 2024-12-25)');
                break;

            case 'track_departure_date':
                if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
                    bot.sendMessage(chatId, '❌ Please use YYYY-MM-DD format (e.g., 2024-12-25)');
                    return;
                }
                userState.data.departure_date = text;
                userState.step = 'track_return_date';
                userStates.set(userId, userState);
                bot.sendMessage(chatId, '🔄 Return date? (YYYY-MM-DD format, or type "oneway" for one-way flight)');
                break;

            case 'track_return_date':
                if (text.toLowerCase() === 'oneway') {
                    userState.data.return_date = null;
                } else if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
                    bot.sendMessage(chatId, '❌ Please use YYYY-MM-DD format or type "oneway"');
                    return;
                } else {
                    userState.data.return_date = text;
                }
                userState.step = 'track_target_price';
                userStates.set(userId, userState);
                bot.sendMessage(chatId, '💰 What\'s your target price? I\'ll alert you when flights drop to this price or below. (e.g., 500)');
                break;

            case 'track_target_price':
                const price = parseInt(text);
                if (isNaN(price) || price <= 0) {
                    bot.sendMessage(chatId, '❌ Please enter a valid price number (e.g., 500)');
                    return;
                }

                await createFlightAlert(chatId, userId, {
                    userId: userId,
                    origin: userState.data.origin,
                    destination: userState.data.destination,
                    departure_date: userState.data.departure_date,
                    return_date: userState.data.return_date,
                    min_price: price
                });
                break;
        }
    } catch (error) {
        console.error('Error in processConversationStep:', error);
        await bot.sendMessage(chatId, '❌ Something went wrong. Please try again or use /start');
        userStates.delete(userId);
    }
}

// ==========================================
// Helper functions
// ==========================================

// Format date from various formats to YYYY-MM-DD
function formatDate(dateStr) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return dateStr;
    } else if (/^\d{2}-\d{2}-\d{2}$/.test(dateStr)) {
        const parts = dateStr.split('-');
        return `20${parts[2]}-${parts[1]}-${parts[0]}`;
    } else if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) {
        const parts = dateStr.split('-');
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
    } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
        const parts = dateStr.split('/');
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return null;
}

// Check if date is valid and in future
function isValidFutureDate(dateStr) {
    const date = new Date(dateStr);
    const currentDate = new Date();

    if (date <= currentDate) {
        return false;
    }

    // Check if date is not too far in future (330 days is typical airline limit)
    const maxFutureDate = new Date();
    maxFutureDate.setDate(maxFutureDate.getDate() + 330);

    return date <= maxFutureDate;
}

// Check if return date is valid compared to departure
function isReturnDateValid(departureDate, returnDate) {
    const departure = new Date(departureDate);
    const returnD = new Date(returnDate);
    return returnD > departure;
}

// Search flights implementation
async function searchFlightsForUser(chatId, userId) {
    const userState = userStates.get(userId);
    if (!userState) return;

    const { origin, destination, departure_date, return_date } = userState.data;

    bot.sendMessage(chatId, '🔍 Let me search for flights... Hold on.');

    try {
        console.log(`Searching flights: ${origin} → ${destination} on ${departure_date}${return_date ? ` with return on ${return_date}` : ' (one-way)'}`);

        const flights = await flightAPI.searchFlights(origin, destination, departure_date, return_date);

        if (flights.length === 0) {
            bot.sendMessage(chatId, '❌ No flights found for this route and date. Please try different dates or cities.');
            userStates.delete(userId);
            return;
        }

        // Find cheapest flight
        let cheapestFlight = flights[0];
        let cheapestPrice = parseFloat(cheapestFlight.price);

        flights.forEach(flight => {
            const currentPrice = parseFloat(flight.price);
            if (currentPrice < cheapestPrice) {
                cheapestPrice = currentPrice;
                cheapestFlight = flight;
            }
        });

        // Get top 5 cheapest flights
        const topFlights = [...flights]
            .sort((a, b) => parseFloat(a.price) - parseFloat(b.price))
            .slice(0, 5);

        // Format message with results
        let message = `✅ Found ${flights.length} flights from ${origin} to ${destination}!\n\n`;
        message += `💰 Most affordable option: $${cheapestFlight.price} (${cheapestFlight.airline})\n`;
        message += `⏱️ Duration: ${cheapestFlight.formattedDuration}${cheapestFlight.stops === 0 ? ' (direct)' : ` (${cheapestFlight.stops} stop${cheapestFlight.stops > 1 ? 's' : ''})`}\n`;
        message += `🕒 Departure: ${new Date(cheapestFlight.departureTime).toLocaleString()} (${origin} local time)\n`;
        message += `🛬 Arrival: ${new Date(cheapestFlight.arrivalTime).toLocaleString()} (${destination} local time)\n\n`;
        message += `🏆 Top 5 most affordable options:\n`;
        topFlights.forEach((flight, index) => {
            message += `${index + 1}. $${flight.price} - ${flight.airline} - ${flight.formattedDuration}\n`;
        });

        message += `\nWant to get notified when prices drop? Upgrade to premium with /premium`;

        // Add keyboard for booking/tracking
        const bookingUrl = flightAPI.generateBookingUrl(origin, destination, departure_date, return_date);
        const keyboard = {
            inline_keyboard: [
                // Only add the Book Now button if bookingUrl is valid
                ...(bookingUrl && bookingUrl.startsWith('http') ? [[{
                    text: '✈️ Book Now',
                    url: bookingUrl
                }]] : []),
                [{
                    text: '🔔 Track Price Changes',
                    callback_data: `track_${origin}_${destination}_${departure_date}${return_date ? '_' + return_date : ''}`
                }]
            ]
        };

        bot.sendMessage(chatId, message, { reply_markup: keyboard });
        userStates.delete(userId);
    } catch (error) {
        console.error('Error searching flights:', error);

        let errorMessage = '❌ Error searching for flights. ';

        if (error.message.includes('airport code')) {
            errorMessage += 'Could not find airport code. Please use city codes like NYC, LON, DEL.';
        } else if (error.message.includes('API')) {
            errorMessage += 'Flight data provider is temporarily unavailable. Please try again later.';
        } else {
            errorMessage += 'Please try again with different search parameters.';
        }

        bot.sendMessage(chatId, errorMessage);
        userStates.delete(userId);
    }
}

// Create flight alert
async function createFlightAlert(chatId, userId, alertData) {
    try {
        // Generate a booking URL if not already provided
        if (!alertData.bookingUrl) {
            alertData.bookingUrl = flightAPI.generateBookingUrl(
                alertData.origin,
                alertData.destination,
                alertData.departure_date,
                alertData.return_date
            );
        }
        const alertId = await firebaseService.createAlert(alertData);

        bot.sendMessage(chatId, `✅ Flight alert created successfully!
    
📍 Route: ${alertData.origin} → ${alertData.destination}
📅 Departure: ${alertData.departure_date}
${alertData.return_date ? `🔄 Return: ${alertData.return_date}` : '🎫 One-way flight'}
💰 Target Price: $${alertData.min_price}
🆔 Alert ID: ${alertId}

I'll start monitoring prices and notify you of any drops! 🔔`);

        // Clean up state
        userStates.delete(userId);

        // Start initial price check
        setTimeout(() => priceMonitor.checkSingleAlert(alertId), 5000);
    } catch (error) {
        console.error('Error creating alert:', error);
        bot.sendMessage(chatId, '❌ Error creating alert. Please try again.');
        userStates.delete(userId);
    }
}

// Setup direct tracking from search result
async function setupDirectTracking(chatId, userId, origin, destination, departureDate, returnDate, callbackQueryId) {
    try {
        // We don't need to check userState here since this is a direct action from search results
        // Even if the original userState was deleted after completing the search

        const flights = await flightAPI.searchFlights(origin, destination, departureDate, returnDate);

        if (flights.length === 0) {
            await bot.answerCallbackQuery(callbackQueryId, {
                text: "No flights found to track",
                show_alert: true
            });
            return;
        }

        // Find cheapest flight price
        let cheapestPrice = parseFloat(flights[0].price);
        flights.forEach(flight => {
            const currentPrice = parseFloat(flight.price);
            if (currentPrice < cheapestPrice) {
                cheapestPrice = currentPrice;
            }
        });

        // Generate booking URL
        const bookingUrl = flightAPI.generateBookingUrl(origin, destination, departureDate, returnDate);

        // Create alert with current price as reference
        const alertData = {
            userId: userId,
            origin: origin,
            destination: destination,
            departure_date: departureDate,
            return_date: returnDate,
            min_price: 0,  // Any price change will trigger notification
            current_price: cheapestPrice,
            bookingUrl: bookingUrl
        };

        const alertId = await firebaseService.createAlert(alertData);

        await bot.sendMessage(chatId, `✅ Flight tracking enabled!
        
📍 Route: ${origin} → ${destination}
📅 Departure: ${departureDate}
${returnDate ? `🔄 Return: ${returnDate}` : '🎫 One-way flight'}
💰 Current Price: $${cheapestPrice}
🆔 Alert ID: ${alertId}

I'll notify you of ANY price changes for this route! 🔔`);

        setTimeout(() => priceMonitor.checkSingleAlert(alertId), 5000);

        await bot.answerCallbackQuery(callbackQueryId, {
            text: "Flight tracking enabled!",
            show_alert: false
        });
    } catch (error) {
        console.error('Error setting up tracking:', error);
        await bot.answerCallbackQuery(callbackQueryId, {
            text: "Error setting up tracking. Please try again.",
            show_alert: true
        });
    }
}

// Show welcome message with menu
function sendWelcomeMessage(chatId) {
    const welcomeMessage = `
🛫 Welcome to AeroWizard!

I can help you:
- 🔍 Search for the most affordable flights 
- 💰 Track price changes and get live alerts
- ✈️ Track flight status and get live updates
- 📱 Use the buttons below to navigate

Need help? Just tap the Help button.
`;

    const keyboard = {
        reply_markup: {
            keyboard: [
                [{ text: '🔍 Search Flights' }],
                [{ text: '💰 My Price Alerts' }, { text: '✈️ My Tracked Flights' }],
                [{ text: '🛫 Track Flights' }, { text: '❓ Help' }],
                [{ text: '⭐ Premium' }, { text: '🔗 Share' }]
            ],
            resize_keyboard: true,
            persistent: true
        }
    };

    bot.sendMessage(chatId, welcomeMessage, keyboard);
}

// Show premium info message
function sendPremiumInfo(chatId) {
    const premiumMessage = `
⭐ Premium Membership ⭐

Currently available free for all for 
limited time!!

Happy Flight Tracking!
`;
    bot.sendMessage(chatId, premiumMessage);
}

// Show help message
function sendHelpInfo(chatId) {
    const helpMessage = `
🛫 AeroWizard Help

How to use:
• 🔍 Search Flights - Find the most affordable flights
• 💰 My Price Alerts - View and manage your fare price alerts
• ✈️ My Tracked Flights - View and manage your flight status tracking
• 🛫 Track Flights - Track a new flight's status
• ⭐ Premium - Upgrade your membership
• 🔗 Share - Share this bot with friends
• ❓ Help - Show this help

How it works:
1. Search for flights to your destination
2. Choose to track prices for routes you're interested in
3. Get notified when prices drop
4. Track specific flights by route or flight number
5. Get notified of schedule changes, delays, and gate information

Need support? Contact @aerowizard_support.

Happy Flight Hunting!
`;
    bot.sendMessage(chatId, helpMessage);
}

function sendShareOptions(chatId) {
    const botUsername = process.env.BOT_USERNAME || 'flightz_bot';
    const shareLink = `https://t.me/${botUsername}`;

    const shareMessage = `
📤 Share AeroWizard

Help your friends and family fly smartly by sharing me!

📎 Share link: ${shareLink}
`;

    const keyboard = {
        inline_keyboard: [
            [{
                text: '📱 Share via Telegram',
                url: `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${encodeURIComponent('Check out this awesome Flight Price Tracker bot!')}`
            }],
            [{
                text: '📋 Copy Link',
                callback_data: 'copy_share_link'
            }]
        ]
    };

    bot.sendMessage(chatId, shareMessage, { reply_markup: keyboard });
}

// ==========================================
// Bot Command Handlers
// ==========================================

// Start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Register user in database
    await firebaseService.createUser(userId, msg.from.username || msg.from.first_name);
    sendWelcomeMessage(chatId);
});

// Search command
bot.onText(/\/search/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    console.log(`User ${userId} used /search command`);
    userStates.delete(userId); // Clear existing state
    userStates.set(userId, { step: 'search_origin', data: {} });

    bot.sendMessage(chatId, '🏠 Which city are you flying FROM? (e.g., NYC, London, Delhi)');
});

// Track command
bot.onText(/\/track/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Premium check commented out for testing
    /*
    const isPremium = await firebaseService.isUserPremium(userId);
    if (!isPremium) {
      bot.sendMessage(chatId, '⭐ This is a Premium Feature ⭐\n\nFlight price tracking is available to premium members only.\nUse /premium to upgrade!');
      return;
    }
    */

    bot.sendMessage(chatId, '✈️ Flight price tracking is currently available for all.');
    userStates.delete(userId);
    userStates.set(userId, { step: 'track_origin', data: {} });
    bot.sendMessage(chatId, '🏠 Which city are you flying FROM? (e.g., NYC, London, Delhi)');
});

bot.onText(/\/myflights/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Use the flightTracker service to show user's tracked flights
    await flightTracker.showUserFlightTracks(chatId, userId);

    try {
        const trackedFlights = await firebaseService.getUserFlightTracks(userId);

        if (!trackedFlights || trackedFlights.length === 0) {
            bot.sendMessage(chatId, '📭 You are not tracking any flights yet. Use the "Track Flights" button to start.');
            return;
        }

        let message = '✈️ Your Tracked Flights:\n\n';
        const keyboard = { inline_keyboard: [] };

        trackedFlights.forEach((flight, index) => {
            message += `${index + 1}. ${flight.carrier_code}${flight.flight_number} on ${flight.date}\n`;
            message += `   From: ${flight.origin || 'N/A'} To: ${flight.destination || 'N/A'}\n`;

            keyboard.inline_keyboard.push([
                {
                    text: `❌ Cancel ${flight.carrier_code}${flight.flight_number}`,
                    callback_data: `cancel_flight_${flight.track_id}`
                }
            ]);
        });

        bot.sendMessage(chatId, message, { reply_markup: keyboard });
    } catch (error) {
        console.error('Error fetching user flight tracks:', error);
        bot.sendMessage(chatId, '❌ Sorry, there was an error retrieving your tracked flights. Please try again later.');
    }
});

// Premium command
bot.onText(/\/premium/, (msg) => {
    sendPremiumInfo(msg.chat.id);
});

// Add this near your other command handlers
bot.onText(/\/debug/, (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    const userState = userStates.get(userId);
    if (userState) {
        bot.sendMessage(chatId, `Current user state:\n\n${JSON.stringify(userState, null, 2)}`);
    } else {
        bot.sendMessage(chatId, "No active user state found.");
    }
});

// Upgrade command
bot.onText(/\/upgrade/, async (msg) => {
    bot.sendMessage(msg.chat.id, '⭐ Please use /premium to learn about our premium subscription!');
});

// Share command
bot.onText(/\/share/, (msg) => {
    sendShareOptions(msg.chat.id);
});

// ==========================================
// Message and Callback Handlers
// ==========================================

// Single message handler for all text messages
bot.on('message', async (msg) => {
    if (!msg.text) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    // Skip commands - they're handled by command handlers
    if (text.startsWith('/')) return;

    // Check if user has an active conversation
    const userState = userStates.get(userId);
    if (userState) {
        // Process active conversation
        return processConversationStep(msg);
    }

    // Handle menu button clicks
    switch (text) {
        case '🔍 Search Flights':
            console.log(`User ${userId} clicked Search Flights button`);
            userStates.set(userId, { step: 'search_origin', data: {} });
            await bot.sendMessage(chatId, '🏠 Which city are you flying FROM? (e.g., NYC, London, Delhi)');
            break;

        case '🛫 Track Flights':
            console.log(`User ${userId} clicked Track Flights button`);

            // COMPLETELY RESET USER STATE with a fresh object
            userStates.delete(userId);
            userStates.set(userId, {
                step: 'track_flight_method',
                data: {
                    trackingMethod: null,
                    origin: null,
                    destination: null,
                    date: null
                }
            });

            const trackingKeyboard = {
                reply_markup: {
                    keyboard: [
                        [{ text: 'Search by Route' }, { text: 'Search by Flight Number' }],
                        [{ text: '🔙 Back to Main Menu' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            };
            await bot.sendMessage(chatId, '✈️ How would you like to track a flight?', trackingKeyboard);
            break;

        // Updated button name for price alerts
        case '💰 My Price Alerts':
            console.log(`User ${userId} clicked My Price Alerts button`);
            await handleMyAlerts(chatId, userId);
            break;

        // New button for tracked flights
        case '✈️ My Tracked Flights':
            console.log(`User ${userId} clicked My Tracked Flights button`);
            await flightTracker.showUserFlightTracks(chatId, userId);
            break;

        case '⭐ Premium':
            sendPremiumInfo(chatId);
            break;

        case '❓ Help':
            sendHelpInfo(chatId);
            break;

        case '🔙 Back to Main Menu':
        case 'Back to Main Menu':
            console.log(`User ${userId} clicked Back to Main Menu button`);
            // Always clear user state no matter what
            userStates.delete(userId);
            // Always show welcome message with keyboard
            sendWelcomeMessage(chatId);
            break;

        case '🔗 Share':
            console.log(`User ${userId} clicked Share button`);
            sendShareOptions(chatId);
            break;
    }
});

// Handler for inline button callbacks
bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;

    try {
        // Handle flight track cancellation first (more specific match)
        if (data.startsWith('cancel_flight_')) {
            // Let the flightTracker handle this
            const handled = await flightTracker.handleCallbackQuery(callbackQuery);
            if (handled) return;
        }

        // Handle history requests
        if (data.startsWith('history_')) {
            const alertId = data.split('_')[1];
            await priceMonitor.sendPriceHistory(chatId, alertId, userId);
            await bot.answerCallbackQuery(callbackQuery.id);
            return;
        }

        // Handle direct tracking from search results (no user state needed)
        if (data.startsWith('track_')) {
            const parts = data.split('_');
            if (parts.length < 4) {
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: "Invalid tracking data",
                    show_alert: true
                });
                return;
            }

            const origin = parts[1];
            const destination = parts[2];
            const departureDate = parts[3];
            const returnDate = parts.length > 4 ? parts[4] : null;

            await setupDirectTracking(chatId, userId, origin, destination, departureDate, returnDate, callbackQuery.id);
            return;
        }

        // Handle price alert cancellations (AFTER checking for flight cancellations)
        if (data.startsWith('cancel_')) {
            const alertId = data.split('_')[1];
            try {
                await firebaseService.cancelAlert(alertId, userId);
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: "Alert cancelled successfully!",
                    show_alert: false
                });

                // Refresh alerts view
                await handleMyAlerts(chatId, userId);
            } catch (error) {
                console.error('Error cancelling alert:', error);
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: "Error cancelling alert. Please try again.",
                    show_alert: true
                });
            }
            return;
        }

        if (data === 'copy_share_link') {
            const botUsername = process.env.BOT_USERNAME || 'flightz_bot';
            const shareLink = `https://t.me/${botUsername}`;

            await bot.answerCallbackQuery(callbackQuery.id, {
                text: "Link copied! Share it with your friends.",
                show_alert: true
            });

            // Send a separate message with just the link for easy copying
            await bot.sendMessage(chatId, shareLink);
            return;
        }

        // Get user state ONLY for operations that require it
        const userState = userStates.get(userId);

        // Check if userState exists before proceeding with state-dependent operations
        if (!userState) {
            // Only show "session expired" for operations that require state
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'Session expired. Please start a new search.'
            });
            return;
        }

        // Handle search new button
        if (data === 'search_new') {
            console.log(`User ${userId} clicked Search New Flights inline button`);
            userStates.delete(userId);
            userStates.set(userId, { step: 'search_origin', data: {} });

            await bot.sendMessage(chatId, '🏠 Which city are you flying FROM? (e.g., NYC, London, Delhi)');
            await bot.answerCallbackQuery(callbackQuery.id);
            return;
        }

        // Handle origin airport selection
        if (data.startsWith('origin_')) {
            const index = parseInt(data.split('_')[1]);

            if (userState.data.airports && userState.data.airports[index]) {
                const selectedAirport = userState.data.airports[index];
                userState.data.origin = selectedAirport.code;
                userState.data.originName = selectedAirport.name;
                userState.step = 'search_destination';
                userStates.set(userId, userState);

                await bot.sendMessage(chatId,
                    `✅ Selected departure: ${selectedAirport.name} (${selectedAirport.code})
                
🎯 Which city are you flying TO?`);
                await bot.answerCallbackQuery(callbackQuery.id);
            }
            return;
        }

        // Handle destination airport selection 
        if (data.startsWith('dest_')) {
            const index = parseInt(data.split('_')[1]);

            if (userState.data.airports && userState.data.airports[index]) {
                const selectedAirport = userState.data.airports[index];
                userState.data.destination = selectedAirport.code;
                userState.data.destinationName = selectedAirport.name;
                userState.step = 'search_departure_date';
                userStates.set(userId, userState);

                await bot.sendMessage(chatId,
                    `✅ Selected destination: ${selectedAirport.name} (${selectedAirport.code})
                
📅 What's your departure date? (YYYY-MM-DD format, e.g., 2024-12-25)`);
                await bot.answerCallbackQuery(callbackQuery.id);
            }
            return;
        }

        // Handle direct tracking from search results
        if (data.startsWith('track_')) {
            const parts = data.split('_');
            if (parts.length < 4) {
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: "Invalid tracking data",
                    show_alert: true
                });
                return;
            }

            const origin = parts[1];
            const destination = parts[2];
            const departureDate = parts[3];
            const returnDate = parts.length > 4 ? parts[4] : null;

            await setupDirectTracking(chatId, userId, origin, destination, departureDate, returnDate, callbackQuery.id);
            return;
        }

        // Handle cancel alerts
        if (data.startsWith('cancel_')) {
            const alertId = data.split('_')[1];
            try {
                await firebaseService.cancelAlert(alertId, userId);
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: "Alert cancelled successfully!",
                    show_alert: false
                });

                // Refresh alerts view
                await handleMyAlerts(chatId, userId);
            } catch (error) {
                console.error('Error cancelling alert:', error);
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: "Error cancelling alert. Please try again.",
                    show_alert: true
                });
            }
            return;
        }

        // Handle flight selection for tracking
        if (data.startsWith('select_flight_')) {
            const index = parseInt(data.split('_')[2]);

            if (userState.data.flights && userState.data.flights[index]) {
                const selectedFlight = userState.data.flights[index];

                try {
                    // Check if this is a multi-segment flight
                    if (selectedFlight.segments && selectedFlight.segments.length > 1) {
                        // Pass all segments for tracking
                        await flightTracker.createFlightTrack(chatId, userId, {
                            date: userState.data.date,
                            origin: userState.data.origin,  // Ensure origin is passed
                            destination: userState.data.destination, // Ensure destination is passed
                            segments: selectedFlight.segments
                        });
                    } else {
                        // Handle single segment flight
                        const segment = selectedFlight.segments[0];
                        await flightTracker.createFlightTrack(chatId, userId, {
                            carrierCode: segment.carrierCode,
                            flightNumber: segment.flightNumber,
                            date: userState.data.date,
                            origin: userState.data.origin,  // Explicitly set origin from userState
                            destination: userState.data.destination  // Explicitly set destination from userState
                        });
                    }

                    // Clear user state
                    userStates.delete(userId);

                    // Update the keyboard without sending a message
                    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                        chat_id: chatId,
                        message_id: callbackQuery.message.message_id
                    });

                    await bot.answerCallbackQuery(callbackQuery.id, {
                        text: "Flight tracking enabled successfully!",
                        show_alert: false
                    });
                } catch (error) {
                    console.error('Error creating flight track:', error);
                    await bot.answerCallbackQuery(callbackQuery.id, {
                        text: 'Error creating flight track. Please try again.',
                        show_alert: true
                    });
                }
            }
            return;
        }

        // Handle flight track cancellation
        if (data.startsWith('cancel_flight_')) {
            // Let the flightTracker handle this
            return await flightTracker.handleCallbackQuery(callbackQuery);
        }

        // Handle other callbacks with priceMonitor
        await priceMonitor.handleCallbackQuery(callbackQuery);
    } catch (error) {
        console.error('Error handling callback query:', error);
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: "Error processing request",
            show_alert: true
        });
    }
});

// ==========================================
// Server Setup
// ==========================================


// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Add webhook setup for production
if (process.env.NODE_ENV === 'production') {
    app.post('/webhook', (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
    bot.setWebHook(process.env.WEBHOOK_URL);
}

// Schedule price monitoring
cron.schedule('0 */4 * * *', () => {
    console.log('Running scheduled price check...');
    priceMonitor.checkAllAlerts();
});

// Check flight status every 30 minutes
cron.schedule('*/30 * * * *', async () => {
    try {
        console.log('Running scheduled flight status check...');
        await flightTracker.checkAllTrackedFlights();
    } catch (error) {
        console.error('Error in scheduled flight status check:', error);
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    firebaseService.close();
    process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;
setupCronEndpoints(app, priceMonitor, flightTracker);
app.listen(PORT, async () => {
    await initialize();
    console.log(`Flight tracker bot running on port ${PORT}`);
    console.log('Bot is ready to receive messages!');
});


module.exports = app;
module.exports.priceMonitor = priceMonitor;
module.exports.flightTracker = flightTracker;