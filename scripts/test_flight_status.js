require('dotenv').config();
const axios = require('axios');
const readline = require('readline');
const FlightAPI = require('../services/flightAPI');

// Create interface for reading user input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function promptUser(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer);
        });
    });
}

async function testFlightStatus() {
    try {
        console.log('🔍 Improved Flight Status API Test');
        console.log('----------------------------------');

        // Initialize the FlightAPI class which has your airport database
        const flightAPI = new FlightAPI();
        let token = null;

        // Get access token
        console.log('Authenticating with Amadeus API...');
        try {
            token = await flightAPI.getAccessToken();
            console.log('✅ Successfully authenticated');
        } catch (error) {
            console.error('❌ Authentication failed:', error.message);
            return;
        }

        // Ask how user wants to search
        console.log('\nHow would you like to search for a flight?');
        console.log('1. By route (origin city, destination city, date)');
        console.log('2. By flight number (airline, flight number, date)');

        const searchChoice = await promptUser('Enter your choice (1 or 2): ');

        if (searchChoice === '1') {
            // Search by route (using city names)
            const originCity = await promptUser('Enter origin city name: ');
            const destinationCity = await promptUser('Enter destination city name: ');
            const departureDate = await promptUser('Enter departure date (YYYY-MM-DD): ');

            console.log('\n🔎 Finding airports for your cities...');

            // Find matching airports using your database
            let originAirports = [];
            let destinationAirports = [];

            try {
                originAirports = await flightAPI.findAirports(originCity);
                console.log(`Found ${originAirports.length} airports near ${originCity}`);

                if (originAirports.length === 0) {
                    console.log('❌ No airports found for the origin city.');
                    return;
                }

                // Display origin airports
                console.log('\nOrigin Airports:');
                originAirports.forEach((airport, index) => {
                    console.log(`${index + 1}. ${airport.name} (${airport.code})`);
                });

                // Let user select origin airport
                const originSelection = parseInt(await promptUser('\nSelect origin airport number: ')) - 1;
                if (originSelection < 0 || originSelection >= originAirports.length) {
                    console.log('❌ Invalid selection.');
                    return;
                }
                const selectedOrigin = originAirports[originSelection];

                destinationAirports = await flightAPI.findAirports(destinationCity);
                console.log(`Found ${destinationAirports.length} airports near ${destinationCity}`);

                if (destinationAirports.length === 0) {
                    console.log('❌ No airports found for the destination city.');
                    return;
                }

                // Display destination airports
                console.log('\nDestination Airports:');
                destinationAirports.forEach((airport, index) => {
                    console.log(`${index + 1}. ${airport.name} (${airport.code})`);
                });

                // Let user select destination airport
                const destSelection = parseInt(await promptUser('\nSelect destination airport number: ')) - 1;
                if (destSelection < 0 || destSelection >= destinationAirports.length) {
                    console.log('❌ Invalid selection.');
                    return;
                }
                const selectedDestination = destinationAirports[destSelection];

                // Before making the API call
                const areAirportsValid = await validateAirports(selectedOrigin.code, selectedDestination.code);
                if (!areAirportsValid) {
                    console.log('⚠️ One or both airports may not be supported in the test environment.');
                    console.log('Trying search anyway, but consider using NYC→LON, MAD→BCN, or PAR→LON instead.');
                }

                console.log(`\n🔍 Searching for flights from ${selectedOrigin.name} (${selectedOrigin.code}) to ${selectedDestination.name} (${selectedDestination.code}) on ${departureDate}...`);

                // Call the searchFlights method from your FlightAPI class
                console.log('Searching flights:', selectedOrigin.code, selectedDestination.code, departureDate);
                const flights = await flightAPI.searchFlights(
                    selectedOrigin.code,
                    selectedDestination.code,
                    departureDate
                );

                if (!flights || flights.length === 0) {
                    console.log('❌ No flights found for this route and date.');
                    return;
                }

                console.log(`\n✅ Found ${flights.length} flights!`);
                console.log('Available Flights:');
                console.log('-----------------');

                // Show all flights with option for pagination if too many
                const maxPerPage = 10;
                let currentPage = 0;

                async function displayFlightPage(page) {
                    const startIdx = page * maxPerPage;
                    const endIdx = Math.min(startIdx + maxPerPage, flights.length);

                    // Add this inside your displayFlightPage function before the loop
                    console.log('Debug - First flight segments:');
                    if (flights.length > 0) {
                        console.log(JSON.stringify(flights[0].segments, null, 2));
                    }

                    for (let i = startIdx; i < endIdx; i++) {
                        const flight = flights[i];
                        const segment = flight.segments?.[0];
                        if (!segment) continue;

                        const departureTime = new Date(segment.departure?.at).toLocaleTimeString('en-US', {
                            hour: '2-digit', minute: '2-digit', hour12: false
                        });

                        const arrivalTime = new Date(segment.arrival?.at).toLocaleTimeString('en-US', {
                            hour: '2-digit', minute: '2-digit', hour12: false
                        });

                        // Include airline and flight number
                        console.log(`${i + 1}. ${segment.carrierCode}${segment.flightNumber} - ${departureTime} → ${arrivalTime} - $${flight.price || 'N/A'} ${flight.airline || ''}`);

                        // Add stops information
                        if (flight.stops > 0) {
                            console.log(`   with ${flight.stops} stop(s) - Total duration: ${flight.formattedDuration || 'Unknown'}`);

                            // Show connection details
                            if (flight.segments && flight.segments.length > 1) {
                                for (let j = 0; j < flight.segments.length; j++) {
                                    const seg = flight.segments[j];
                                    const depAirport = seg.departure?.iataCode;
                                    const arrAirport = seg.arrival?.iataCode;

                                    if (depAirport && arrAirport) {
                                        console.log(`   Segment ${j + 1}: ${depAirport} → ${arrAirport}`);
                                    }
                                }
                            } else {
                                console.log('   Connection details not available');
                            }
                        } else {
                            console.log(`   Direct flight - Duration: ${flight.formattedDuration || 'Unknown'}`);
                        }
                        console.log('');
                    }

                    console.log(`Showing ${startIdx + 1}-${endIdx} of ${flights.length} flights`);
                }

                // Display first page
                await displayFlightPage(currentPage);

                // Pagination controls if needed
                let browsing = true;
                const totalPages = Math.ceil(flights.length / maxPerPage);

                if (totalPages > 1) {
                    while (browsing) {
                        const pageAction = await promptUser(`\nPage ${currentPage + 1}/${totalPages}. Enter 'n' for next page, 'p' for previous, or a flight number to select: `);

                        if (pageAction.toLowerCase() === 'n' && currentPage < totalPages - 1) {
                            currentPage++;
                            await displayFlightPage(currentPage);
                        } else if (pageAction.toLowerCase() === 'p' && currentPage > 0) {
                            currentPage--;
                            await displayFlightPage(currentPage);
                        } else if (!isNaN(parseInt(pageAction))) {
                            browsing = false;

                            const selectedFlightIdx = parseInt(pageAction) - 1;
                            if (selectedFlightIdx >= 0 && selectedFlightIdx < flights.length) {
                                const selectedFlight = flights[selectedFlightIdx];

                                // Check if this is a multi-segment flight
                                if (selectedFlight.segments && selectedFlight.segments.length > 1) {
                                    console.log("\n🔄 This is a connecting flight with multiple segments.");
                                    console.log("Checking status for each flight segment:");

                                    // Loop through all segments and check status for each one
                                    for (let i = 0; i < selectedFlight.segments.length; i++) {
                                        const segment = selectedFlight.segments[i];
                                        const segmentDate = i === 0 ? departureDate :
                                            // For subsequent segments, extract date from segment's departure time
                                            new Date(segment.departure.at).toISOString().split('T')[0];

                                        console.log(`\n📝 Segment ${i + 1}: ${segment.carrierCode}${segment.flightNumber} (${segment.departure.airport} → ${segment.arrival.airport})`);

                                        await checkAndDisplayFlightStatus(
                                            segment.carrierCode,
                                            segment.flightNumber,
                                            segmentDate,
                                            segment.departure.airport,
                                            segment.arrival.airport
                                        );
                                    }
                                } else {
                                    // Original code for single-segment flights
                                    const segment = selectedFlight.segments[0];
                                    await checkAndDisplayFlightStatus(
                                        segment.carrierCode,
                                        segment.flightNumber,
                                        departureDate,
                                        segment.departure.airport,
                                        segment.arrival.airport
                                    );
                                }
                            } else {
                                console.log('❌ Invalid flight selection.');
                            }
                        } else {
                            browsing = false;
                        }
                    }
                } else {
                    // Single page, just ask for selection
                    const selectedFlightIdx = parseInt(await promptUser('\nEnter a flight number to check its status: ')) - 1;

                    if (selectedFlightIdx >= 0 && selectedFlightIdx < flights.length) {
                        const selectedFlight = flights[selectedFlightIdx];

                        // Check if this is a multi-segment flight
                        if (selectedFlight.segments && selectedFlight.segments.length > 1) {
                            console.log("\n🔄 This is a connecting flight with multiple segments.");
                            console.log("Checking status for each flight segment:");

                            // Loop through all segments and check status for each one
                            for (let i = 0; i < selectedFlight.segments.length; i++) {
                                const segment = selectedFlight.segments[i];
                                const segmentDate = i === 0 ? departureDate :
                                    // For subsequent segments, extract date from segment's departure time
                                    new Date(segment.departure.at).toISOString().split('T')[0];

                                console.log(`\n📝 Segment ${i + 1}: ${segment.carrierCode}${segment.flightNumber} (${segment.departure.airport} → ${segment.arrival.airport})`);

                                await checkAndDisplayFlightStatus(
                                    segment.carrierCode,
                                    segment.flightNumber,
                                    segmentDate,
                                    segment.departure.airport,
                                    segment.arrival.airport
                                );
                            }
                        } else {
                            // Original code for single-segment flights
                            const segment = selectedFlight.segments[0];
                            await checkAndDisplayFlightStatus(
                                segment.carrierCode,
                                segment.flightNumber,
                                departureDate,
                                segment.departure.airport,
                                segment.arrival.airport
                            );
                        }
                    } else {
                        console.log('❌ Invalid flight selection.');
                    }
                }

            } catch (error) {
                console.error('Error during airport search or flight search:', error);
                console.log('❌ Failed to find airports or flights.');
                if (error.response) {
                    console.error('API Error:', error.response.data);
                }
            }

        } else {
            // Option 2: Search directly by airline and flight number
            const airlineName = await promptUser('Enter airline name or code (e.g., "American" or "AA"): ');
            const flightNumber = await promptUser('Enter flight number (e.g., 123): ');
            const departureDate = await promptUser('Enter departure date (YYYY-MM-DD): ');

            // Map common airline names to codes
            const airlineCode = await findAirlineCode(airlineName);
            console.log(`Using airline code: ${airlineCode}`);

            await checkAndDisplayFlightStatus(
                airlineCode,
                flightNumber,
                departureDate
                // No expected origin/destination since user is searching directly
            );
        }

    } catch (error) {
        console.error('\n❌ Test failed:', error);
    } finally {
        rl.close();
    }
}

async function validateAirports(originCode, destinationCode) {
    // Common airports known to work in test environment
    const validTestAirports = [
        'MAD', 'BCN', 'LHR', 'CDG', 'AMS', 'FRA', 'IST', 'FCO',
        'ATH', 'LIS', 'BRU', 'VIE', 'MUC', 'ZRH', 'BER', 'NYC',
        'LON', 'PAR'
    ];

    console.log(`Checking if airports ${originCode} and ${destinationCode} are valid in test environment...`);

    const originValid = validTestAirports.includes(originCode);
    const destValid = validTestAirports.includes(destinationCode);

    if (!originValid) {
        console.log(`⚠️ Warning: Origin airport ${originCode} may not be supported in test environment`);
    }

    if (!destValid) {
        console.log(`⚠️ Warning: Destination airport ${destinationCode} may not be supported in test environment`);
    }

    return originValid && destValid;
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

    // Try to get exact match
    const normalizedName = airlineName.toLowerCase().trim();
    if (commonAirlines[normalizedName]) {
        return commonAirlines[normalizedName];
    }

    // Try to get partial match
    for (const [name, code] of Object.entries(commonAirlines)) {
        if (name.includes(normalizedName) || normalizedName.includes(name)) {
            return code;
        }
    }

    // If no match, return the original input (it might be the code already)
    return airlineName.toUpperCase();
}

// Helper function for checking and displaying flight status
// Updated to match Amadeus API response structure
async function checkAndDisplayFlightStatus(carrierCode, flightNumber, departureDate, expectedOrigin = null, expectedDestination = null) {
    console.log(`\n🔍 Checking status for flight ${carrierCode}${flightNumber} on ${departureDate}...`);

    try {
        // Get access token
        const flightAPI = new FlightAPI();
        const token = await flightAPI.getAccessToken();

        // Make direct API call for flight status with correct parameters
        const response = await axios.get(
            `https://test.api.amadeus.com/v2/schedule/flights`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                params: {
                    carrierCode,
                    flightNumber,
                    scheduledDepartureDate: departureDate
                }
            }
        );

        // Log the raw API response for debugging
        console.log('\n🔧 API Response Structure:');
        console.log(JSON.stringify(response.data, null, 2));

        if (!response.data || !response.data.data || response.data.data.length === 0) {
            console.log('❌ No flight information found for the provided details.');
            return;
        }

        console.log('\n✅ Flight Status Results:');
        console.log('------------------------');

        for (const flight of response.data.data) {
            const flightPoints = flight.flightPoints;
            if (!flightPoints || flightPoints.length < 2) {
                console.log('❌ Incomplete flight information returned by API.');
                continue;
            }

            // Extract departure and arrival information based on actual API response structure
            const departurePoint = flightPoints[0];
            const arrivalPoint = flightPoints[1];

            if (expectedOrigin && expectedDestination) {
                const actualOrigin = departurePoint.iataCode;
                const actualDestination = arrivalPoint.iataCode;

                if (actualOrigin !== expectedOrigin || actualDestination !== expectedDestination) {
                    console.log(`\n⚠️ Route Mismatch Warning: 
- Expected route: ${expectedOrigin}→${expectedDestination}
- Actual flight route: ${actualOrigin}→${actualDestination}
                    
This is likely a codeshare flight - the flight number you selected is marketed by ${carrierCode} 
but operates on a different route than shown in search results.`);
                }
            }


            // Extract times from timings array
            const departureTime = departurePoint.departure?.timings?.[0]?.value || null;
            const arrivalTime = arrivalPoint.arrival?.timings?.[0]?.value || null;

            // Format the times to be more readable
            const formattedDepartureTime = departureTime ?
                new Date(departureTime).toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                }) : 'Unknown';

            const formattedArrivalTime = arrivalTime ?
                new Date(arrivalTime).toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                }) : 'Unknown';

            // Extract aircraft type
            const aircraftType = flight.legs?.[0]?.aircraftEquipment?.aircraftType || 'Unknown';

            // Extract flight duration
            const duration = flight.legs?.[0]?.scheduledLegDuration ||
                flight.segments?.[0]?.scheduledSegmentDuration || 'Unknown';

            // Format the duration to be more readable
            const formattedDuration = formatDuration(duration);

            // Check for codeshare/operating flight
            const isCodeshare = !!flight.segments?.[0]?.partnership?.operatingFlight;
            const operatingCarrier = isCodeshare ?
                flight.segments[0].partnership.operatingFlight.carrierCode : null;
            const operatingFlight = isCodeshare ?
                flight.segments[0].partnership.operatingFlight.flightNumber : null;

            console.log(`
✈️ Flight: ${flight.flightDesignator.carrierCode}${flight.flightDesignator.flightNumber}
🗓️ Date: ${flight.scheduledDepartureDate}
🛫 Departure: ${departurePoint.iataCode} at ${formattedDepartureTime}
🛬 Arrival: ${arrivalPoint.iataCode} at ${formattedArrivalTime}
⏱️ Duration: ${formattedDuration}
🛩️ Aircraft: ${aircraftType}
${isCodeshare ? `🔄 Operated by: ${operatingCarrier}${operatingFlight}` : ''}
📊 Status: Scheduled
            `);

            // Handle multi-segment flight (connections)
            if (flightPoints.length > 2) {
                console.log('📍 Connections:');
                for (let i = 1; i < flightPoints.length - 1; i++) {
                    console.log(`   Stop at: ${flightPoints[i].iataCode}`);
                }
            }
        }
    } catch (error) {
        console.error('\n❌ Error fetching flight status:', error.message);
        if (error.response?.data) {
            console.error('API Error:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

// Helper function to format PT duration format
function formatDuration(ptDuration) {
    if (!ptDuration || !ptDuration.startsWith('PT')) {
        return "Unknown";
    }

    try {
        // PT1H35M format
        const hours = ptDuration.match(/(\d+)H/);
        const minutes = ptDuration.match(/(\d+)M/);

        const hoursValue = hours ? parseInt(hours[1]) : 0;
        const minutesValue = minutes ? parseInt(minutes[1]) : 0;

        return `${hoursValue}h ${minutesValue}m`;
    } catch (error) {
        return ptDuration; // Return original if parsing fails
    }
}

testFlightStatus();