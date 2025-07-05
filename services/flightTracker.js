const axios = require('axios');

class FlightTracker {
    constructor(bot, flightAPI, database, userStates) {
        this.bot = bot;
        this.flightAPI = flightAPI;
        this.db = database;
        this.userStates = userStates;

        // Time between status checks in minutes
        this.checkInterval = 30;
    }

    // Check all tracked flights
    async checkAllTrackedFlights() {
        console.log('Checking status for all tracked flights...');
        try {
            const trackedFlights = await this.db.getAllActiveFlightTracks();
            console.log(`Found ${trackedFlights.length} tracked flights`);

            // Process in batches to avoid API rate limits
            for (let i = 0; i < trackedFlights.length; i++) {
                await this.checkSingleFlightStatus(trackedFlights[i].track_id);

                // Add a small delay between requests to prevent rate limiting
                if (i < trackedFlights.length - 1) {
                    await this.sleep(2000);
                }
            }
        } catch (error) {
            console.error('Error checking flight statuses:', error);
        }
    }

    // Check a single tracked flight
    async checkSingleFlightStatus(trackId) {
        try {
            const track = await this.db.getFlightTrack(trackId);

            if (!track || !track.active) {
                console.log(`Track ${trackId} not found or inactive`);
                return;
            }

            console.log(`Checking flight ${track.carrier_code}${track.flight_number} on ${track.date}`);

            // Get current status from API
            const currentStatus = await this.getFlightStatus(
                track.carrier_code,
                track.flight_number,
                track.date
            );

            if (!currentStatus) {
                console.log(`No status information found for flight ${track.carrier_code}${track.flight_number}`);
                return;
            }

            // Compare with previous status
            if (this.shouldNotifyUser(track, currentStatus)) {
                // Send notification to user
                await this.sendStatusUpdate(track, currentStatus);

                // Update database with new status
                await this.db.updateFlightTrackStatus(trackId, currentStatus);
            } else {
                // Just update the last checked timestamp
                await this.db.updateFlightTrackCheckTime(trackId);
            }

        } catch (error) {
            console.error(`Error checking flight track ${trackId}:`, error);
        }
    }

    // Get flight status from API
    async getFlightStatus(carrierCode, flightNumber, date) {
        try {
            // Get access token
            const token = await this.flightAPI.getAccessToken();

            // Make API call for flight status
            const response = await axios.get(
                `https://api.amadeus.com/v2/schedule/flights`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    params: {
                        carrierCode,
                        flightNumber,
                        scheduledDepartureDate: date
                    }
                }
            );

            if (!response.data || !response.data.data || response.data.data.length === 0) {
                return null;
            }

            const flight = response.data.data[0];
            const flightPoints = flight.flightPoints;

            if (!flightPoints || flightPoints.length < 2) {
                return null;
            }

            // Extract departure and arrival information
            const departurePoint = flightPoints[0];
            const arrivalPoint = flightPoints[flightPoints.length - 1];

            // Extract times from timings array
            const departureTime = departurePoint.departure?.timings?.[0]?.value || null;
            const arrivalTime = arrivalPoint.arrival?.timings?.[0]?.value || null;

            // Extract other details
            const terminal = arrivalPoint.arrival?.terminal || null;
            const gate = arrivalPoint.arrival?.gate || null;

            // Build status object
            return {
                flightDesignator: flight.flightDesignator,
                departureAirport: departurePoint.iataCode,
                arrivalAirport: arrivalPoint.iataCode,
                scheduledDepartureTime: departureTime,
                scheduledArrivalTime: arrivalTime,
                actualDepartureTime: departureTime, // In test API, these are the same
                actualArrivalTime: arrivalTime, // In test API, these are the same
                terminal: terminal,
                gate: gate,
                status: "SCHEDULED", // Default for test API, real API would have more statuses
                checked: new Date().toISOString()
            };
        } catch (error) {
            console.error('Error fetching flight status:', error);
            return null;
        }
    }

    // Determine if we should notify user based on changes
    shouldNotifyUser(track, currentStatus) {
        // If no previous status exists, notify user with initial status
        if (!track.last_status) {
            return true;
        }

        let lastStatus;
        try {
            lastStatus = JSON.parse(track.last_status);
        } catch (error) {
            console.error('Error parsing last status:', error);
            return true; // Notify if we can't parse previous status
        }

        // Check for significant changes that warrant notification
        const significantChanges = [
            // Flight number changed
            currentStatus.flightDesignator.carrierCode !== lastStatus.flightDesignator?.carrierCode ||
            currentStatus.flightDesignator.flightNumber !== lastStatus.flightDesignator?.flightNumber,

            // Departure or arrival times changed by more than 10 minutes
            this.timeChangedSignificantly(currentStatus.scheduledDepartureTime, lastStatus.scheduledDepartureTime, 10),
            this.timeChangedSignificantly(currentStatus.scheduledArrivalTime, lastStatus.scheduledArrivalTime, 10),

            // Terminal or gate changed
            currentStatus.terminal !== lastStatus.terminal && (currentStatus.terminal || lastStatus.terminal),
            currentStatus.gate !== lastStatus.gate && (currentStatus.gate || lastStatus.gate),

            // Status changed (delayed, cancelled, etc.)
            currentStatus.status !== lastStatus.status,

            // Check at least once per day even if no changes
            this.daysSinceLastCheck(lastStatus.checked) >= 1
        ];

        return significantChanges.some(change => change === true);
    }

    // Helper to check if time changed significantly (in minutes)
    timeChangedSignificantly(time1, time2, minutesThreshold) {
        if (!time1 || !time2) return false;

        const date1 = new Date(time1);
        const date2 = new Date(time2);

        const diffMinutes = Math.abs((date1 - date2) / (1000 * 60));
        return diffMinutes > minutesThreshold;
    }

    // Helper to check days since last check
    daysSinceLastCheck(lastChecked) {
        if (!lastChecked) return 999; // Large number to ensure notification

        const lastCheck = new Date(lastChecked);
        const now = new Date();
        const diffDays = (now - lastCheck) / (1000 * 60 * 60 * 24);
        return diffDays;
    }

    // Send notification to user about flight status change
    async sendStatusUpdate(track, status) {
        try {
            // Get user's telegram ID
            const telegramId = track.telegram_id;
            if (!telegramId) {
                console.error('No telegram ID found for track:', track.track_id);
                return;
            }

            // Format departure and arrival times
            const departureTime = status.scheduledDepartureTime ?
                new Date(status.scheduledDepartureTime).toLocaleString('en-US', {
                    month: 'short',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                }) : 'Unknown';

            const arrivalTime = status.scheduledArrivalTime ?
                new Date(status.scheduledArrivalTime).toLocaleString('en-US', {
                    month: 'short',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                }) : 'Unknown';

            // Create message
            let message = `✈️ Flight Status Update!\n\n`;
            message += `Flight: ${status.flightDesignator.carrierCode}${status.flightDesignator.flightNumber}\n`;
            message += `Route: ${status.departureAirport} → ${status.arrivalAirport}\n`;
            message += `Date: ${track.date}\n\n`;

            message += `🛫 Departure: ${departureTime} from ${status.departureAirport}\n`;
            message += `🛬 Arrival: ${arrivalTime} at ${status.arrivalAirport}\n`;

            if (status.terminal) {
                message += `🏢 Terminal: ${status.terminal}\n`;
            }

            if (status.gate) {
                message += `🚪 Gate: ${status.gate}\n`;
            }

            message += `📊 Status: ${status.status}\n\n`;

            // Add cancel button
            const keyboard = {
                inline_keyboard: [
                    [{
                        text: '❌ Stop Tracking This Flight',
                        callback_data: `cancel_flight_${track.track_id}`
                    }]
                ]
            };

            // Send message
            await this.bot.sendMessage(telegramId, message, {
                reply_markup: keyboard
            });

            console.log(`Sent flight status update to user ${telegramId} for flight ${status.flightDesignator.carrierCode}${status.flightDesignator.flightNumber}`);
        } catch (error) {
            console.error('Error sending status update:', error);
        }
    }

    // Handle callback queries (mainly for cancellation)
    async handleCallbackQuery(callbackQuery) {
        const data = callbackQuery.data;
        const chatId = callbackQuery.message.chat.id;
        const userId = callbackQuery.from.id;

        // Handle flight tracking cancellation
        if (data.startsWith('cancel_flight_')) {
            const trackId = data.split('cancel_flight_')[1];

            try {
                console.log(`Attempting to cancel flight track ${trackId} for user ${userId}`);

                // Cancel the flight track
                const success = await this.db.cancelFlightTrack(trackId, userId);

                if (success) {
                    await this.bot.answerCallbackQuery(callbackQuery.id, {
                        text: "Flight tracking cancelled successfully!",
                        show_alert: false
                    });

                    await this.bot.sendMessage(chatId, "✅ You will no longer receive updates for this flight.");

                    // Refresh flight tracks view
                    await this.showUserFlightTracks(chatId, userId);
                } else {
                    throw new Error('Could not cancel flight track - track not found or not owned by user');
                }
            } catch (error) {
                console.error(`Error cancelling flight track ${trackId}:`, error);
                await this.bot.answerCallbackQuery(callbackQuery.id, {
                    text: "Error cancelling flight tracking. Please try again.",
                    show_alert: true
                });
            }
            return true;
        }

        return false; // Not handled
    }

    // Show user's tracked flights
    async showUserFlightTracks(chatId, userId) {
        try {
            const trackedFlights = await this.db.getUserFlightTracks(userId);

            if (!trackedFlights || trackedFlights.length === 0) {
                this.bot.sendMessage(chatId, '📭 You are not tracking any flights. Use the "Track Flights" button to start.');
                return;
            }

            // Group flights by parent route or treat as individual flights
            const groupedFlights = {};
            const singleFlights = [];

            trackedFlights.forEach(flight => {
                // Check if this is part of a multi-segment journey
                if (flight.parent_route && flight.is_segment) {
                    if (!groupedFlights[flight.parent_route]) {
                        groupedFlights[flight.parent_route] = [];
                    }
                    groupedFlights[flight.parent_route].push(flight);
                } else {
                    singleFlights.push(flight);
                }
            });

            let message = '✈️ Your Tracked Flights:\n\n';
            const keyboard = { inline_keyboard: [] };
            let index = 1;

            // Process multi-segment journeys first
            for (const [route, segments] of Object.entries(groupedFlights)) {
                // Sort segments by segment_index
                segments.sort((a, b) => a.segment_index - b.segment_index);

                // Extract origin and destination from the parent route
                let origin = 'N/A';
                let destination = 'N/A';

                if (route.includes('-')) {
                    [origin, destination] = route.split('-');
                }

                const firstSegment = segments[0];

                message += `${index}. Multi-segment journey on ${firstSegment.date}\n`;
                message += `   From: ${origin} To: ${destination}\n`;
                message += `   Segments: ${segments.length}\n\n`;

                keyboard.inline_keyboard.push([
                    {
                        text: `❌ Cancel journey ${origin} → ${destination}`,
                        callback_data: `cancel_flight_${firstSegment.track_id}`
                    }
                ]);

                index++;
            }

            // Process single flights
            singleFlights.forEach(flight => {
                const origin = flight.origin || 'N/A';
                const destination = flight.destination || 'N/A';

                message += `${index}. ${flight.carrier_code}${flight.flight_number} on ${flight.date}\n`;
                message += `   From: ${origin} To: ${destination}\n\n`;

                keyboard.inline_keyboard.push([
                    {
                        text: `❌ Cancel ${flight.carrier_code}${flight.flight_number}`,
                        callback_data: `cancel_flight_${flight.track_id}`
                    }
                ]);

                index++;
            });

            this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
        } catch (error) {
            console.error('Error fetching user flight tracks:', error);
            this.bot.sendMessage(chatId, '❌ Sorry, there was an error retrieving your tracked flights. Please try again later.');
        }
    }

    // Create a new flight track
    async createFlightTrack(chatId, userId, flightData) {
        try {
            // Check if this is a multi-segment flight from search results
            if (flightData.segments && flightData.segments.length > 1) {
                console.log("This is a multi-segment flight with segments:", flightData.segments.length);

                // First send confirmation message for the entire journey
                await this.bot.sendMessage(chatId, `✅ Flight tracking enabled for multi-segment journey!
            
🛫 From: ${flightData.origin}
🛬 To: ${flightData.destination}
📅 Date: ${flightData.date}
🔄 Number of segments: ${flightData.segments.length}
            
I'll notify you of any schedule changes or updates for all flight segments! 🔔`);

                // Track each segment separately IN SEQUENCE with await
                const trackIds = [];
                for (let i = 0; i < flightData.segments.length; i++) {
                    const segment = flightData.segments[i];
                    const segmentDate = i === 0 ? flightData.date :
                        new Date(segment.departure.at).toISOString().split('T')[0];

                    // Make sure origin and destination are properly set from the segment data
                    const trackId = await this.db.createFlightTrack({
                        userId: userId,
                        telegramId: userId,
                        carrierCode: segment.carrierCode,
                        flightNumber: segment.flightNumber,
                        date: segmentDate,
                        origin: segment.departure.iataCode,  // Ensure this is explicitly set
                        destination: segment.arrival.iataCode, // Ensure this is explicitly set
                        isSegment: true,
                        segmentIndex: i,
                        parentRoute: `${flightData.origin}-${flightData.destination}`
                    });

                    trackIds.push(trackId);

                    // Check status for THIS segment before moving to next segment
                    await this.checkSingleFlightStatus(trackId);

                    // Add a small delay between segments
                    if (i < flightData.segments.length - 1) {
                        await this.sleep(1500);
                    }
                }

                return trackIds[0]; // Return the first track ID
            }
            // If it's a direct flight or we're tracking by flight number
            else {
                // Make sure we have both origin and destination explicitly set
                const trackId = await this.db.createFlightTrack({
                    userId: userId,
                    telegramId: userId,
                    carrierCode: flightData.carrierCode,
                    flightNumber: flightData.flightNumber,
                    date: flightData.date,
                    origin: flightData.origin || (flightData.segments && flightData.segments[0] ?
                        flightData.segments[0].departure.iataCode : null),
                    destination: flightData.destination || (flightData.segments && flightData.segments[0] ?
                        flightData.segments[0].arrival.iataCode : null)
                });

                // Send confirmation message
                await this.bot.sendMessage(chatId, `✅ Flight tracking enabled!
            
✈️ Flight: ${flightData.carrierCode}${flightData.flightNumber}
📅 Date: ${flightData.date}
🛫 From: ${flightData.origin || (flightData.segments && flightData.segments[0] ?
                        flightData.segments[0].departure.iataCode : 'N/A')}
🛬 To: ${flightData.destination || (flightData.segments && flightData.segments[0] ?
                        flightData.segments[0].arrival.iataCode : 'N/A')}
            
I'll notify you of any schedule changes or updates for this flight! 🔔`);

                // Do an immediate check to get initial status
                setTimeout(() => this.checkSingleFlightStatus(trackId), 2000);

                return trackId;
            }
        } catch (error) {
            console.error('Error creating flight track:', error);
            throw error;
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = FlightTracker;