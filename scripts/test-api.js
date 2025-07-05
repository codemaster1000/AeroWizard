require('dotenv').config();
const FlightAPI = require('../services/flightAPI');

async function testAPI() {
    const api = new FlightAPI();
    try {
        const flights = await api.searchFlights('NYC', 'LAX', '2024-12-25');
        console.log('✅ Flight API working:', flights[0]);
    } catch (error) {
        console.error('❌ Flight API failed:', error);
    }
}

testAPI();