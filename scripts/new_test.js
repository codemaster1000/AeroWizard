require('dotenv').config();
const FlightAPI = require('../services/flightAPI');
const readline = require('readline');

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

async function troubleshootAPI() {
    const api = new FlightAPI();
    try {
        console.log('1. Testing API authentication...');
        const token = await api.getAccessToken();
        console.log(`✅ API authentication successful: ${token.substring(0, 10)}...`);

        console.log('2. Testing airport code lookup...');
        const nycCode = await api.searchAirport('NYC');
        const lonCode = await api.searchAirport('LON');
        console.log(`✅ Airport codes: NYC -> ${nycCode}, LON -> ${lonCode}`);

        console.log('3. Testing flight search with known working route...');

        // Get user input for departure date
        const userDate = await promptUser('Enter a departure date (YYYY-MM-DD format): ');

        // Validate date format
        if (!/^\d{4}-\d{2}-\d{2}$/.test(userDate)) {
            throw new Error('Invalid date format. Please use YYYY-MM-DD format.');
        }

        console.log(`Searching for flights from NYC to LON on ${userDate}`);
        const flights = await api.searchFlights('NYC', 'LON', userDate);

        if (flights.length > 0) {
            console.log(`✅ Found ${flights.length} flights!`);

            // Find the cheapest flight
            let cheapestFlight = flights[0];
            let cheapestPrice = parseFloat(cheapestFlight.price);

            flights.forEach(flight => {
                const currentPrice = parseFloat(flight.price);
                if (currentPrice < cheapestPrice) {
                    cheapestPrice = currentPrice;
                    cheapestFlight = flight;
                }
            });

            console.log(`Cheapest flight: $${cheapestFlight.price} ${cheapestFlight.currency}`);
            console.log('Cheapest flight details:', JSON.stringify(cheapestFlight, null, 2));

            // Optionally, show all flights prices for comparison
            console.log('\nAll available flights:');
            flights.forEach((flight, index) => {
                console.log(`${index + 1}. $${flight.price} ${flight.currency} - ${flight.airline} - Duration: ${flight.formattedDuration}`);
            });
        } else {
            console.log('⚠️ No flights found, but API connection is working');
        }
    } catch (error) {
        console.error('❌ API troubleshooting failed:', error);
        console.error('Error details:', error.response?.data || error.message);
    } finally {
        // Close the readline interface
        rl.close();
    }
}

troubleshootAPI();