const axios = require('axios');
const airportCodes = require('../data/airportCodes');

// Try to load extended airport codes, fall back to standard if not available
let extendedAirportCodes = airportCodes;
try {
    const extendedCodes = require('../data/airportCodesExtended');
    console.log(`Loaded extended airport database with ${Object.keys(extendedCodes).length} entries`);
    extendedAirportCodes = extendedCodes;
} catch (error) {
    console.log('Using standard airport database');
}

class FlightAPI {
    constructor() {
        this.amadeus = {
            apiKey: process.env.AMADEUS_API_KEY,
            apiSecret: process.env.AMADEUS_API_SECRET,
            accessToken: null,
            tokenExpiry: null,
            baseURL: 'https://api.amadeus.com'
        };

        // Airport code cache to avoid repeated lookups
        this.airportCache = new Map();

        // Rate limiting
        this.lastRequest = 0;
        this.minRequestInterval = 1000; // 1 second between requests
        this.setupTokenRefreshTimer();
    }

    setupTokenRefreshTimer() {
        // Clear any existing timer
        if (this.tokenRefreshTimer) {
            clearInterval(this.tokenRefreshTimer);
        }

        // Refresh token every 25 minutes (1500 seconds)
        // This is before the 30-minute (1799 seconds) expiry
        const refreshInterval = 25 * 60 * 1000;
        this.tokenRefreshTimer = setInterval(async () => {
            try {
                console.log("Proactively refreshing Amadeus access token...");
                await this.getAccessToken();
            } catch (error) {
                console.error("Failed to refresh token:", error.message);
            }
        }, refreshInterval);
    }

    // Clean up timer when needed
    cleanup() {
        if (this.tokenRefreshTimer) {
            clearInterval(this.tokenRefreshTimer);
        }
    }

    async checkApiHealth() {
        try {
            // Try to get a new token to verify credentials are correct
            await this.getAccessToken();

            // Make a simple API request to verify connection
            // Using correct parameters as per API docs
            const response = await this.makeRequest('/v1/reference-data/locations', {
                keyword: 'LON',
                subType: 'CITY',
                'page[limit]': 1
            });

            console.log("API health check successful");
            return true;
        } catch (error) {
            console.error("API health check failed:", error.message);
            return false;
        }
    }

    async getAccessToken() {
        // Check if token exists and is not expired
        if (this.token && this.tokenExpiry > Date.now()) {
            return this.token;
        }

        // Token is expired or doesn't exist - request a new one
        console.log("Access token expired or not found, requesting new token...");

        try {
            // Add retry logic with exponential backoff
            let retries = 0;
            const maxRetries = 3;

            while (retries < maxRetries) {
                try {
                    const response = await axios.post(
                        `${this.amadeus.baseURL}/v1/security/oauth2/token`,
                        `grant_type=client_credentials&client_id=${this.amadeus.apiKey}&client_secret=${this.amadeus.apiSecret}`,
                        {
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded'
                            }
                        }
                    );

                    this.token = response.data.access_token;
                    // Set expiry time with a 5-minute buffer to be safe
                    this.tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;
                    console.log(`New access token acquired, valid for ${response.data.expires_in} seconds`);

                    return this.token;
                } catch (error) {
                    retries++;
                    if (retries >= maxRetries) throw error;

                    // Exponential backoff
                    const delay = 1000 * Math.pow(2, retries);
                    console.log(`Token acquisition failed, retrying in ${delay}ms (attempt ${retries}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        } catch (error) {
            console.error('Failed to get access token after multiple attempts:',
                error.response?.data?.error_description ||
                error.response?.data?.error ||
                error.message);
            throw error;
        }
    }

    async makeRequest(endpoint, params = {}) {
        // Rate limiting
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequest;
        if (timeSinceLastRequest < this.minRequestInterval) {
            await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
        }
        this.lastRequest = Date.now();

        try {
            const token = await this.getAccessToken();
            const response = await axios.get(`${this.amadeus.baseURL}${endpoint}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                params
            });

            // Return both status and data
            return {
                status: response.status,
                data: response.data
            };
        } catch (error) {
            console.error(`API request failed for ${endpoint}:`, error.response?.data || error.message);
            throw error;
        }
    }

    async searchAirport(cityName) {
        // Check cache first
        const normalizedCity = cityName.toLowerCase().trim();

        if (this.airportCache.has(normalizedCity)) {
            return this.airportCache.get(normalizedCity);
        }

        // Check the imported airport codes database
        // Replace airportCodes with extendedAirportCodes
        if (extendedAirportCodes[normalizedCity]) {
            console.log(`Using local database for ${cityName}: ${extendedAirportCodes[normalizedCity]}`);
            // Cache the result
            this.airportCache.set(normalizedCity, extendedAirportCodes[normalizedCity]);
            return extendedAirportCodes[normalizedCity];
        }

        try {
            // Following exactly what the API documentation specifies
            const response = await this.makeRequest('/v1/reference-data/locations', {
                keyword: cityName,
                subType: 'AIRPORT,CITY',
                'page[limit]': 5
            });

            // Check if data exists and has entries
            if (response && response.data && response.data.length > 0) {
                // Get the first result
                const location = response.data[0];
                const airportCode = location.iataCode;

                console.log(`Found airport code for ${cityName}: ${airportCode}`);

                // Cache the result - normalizedCity is now in scope
                this.airportCache.set(normalizedCity, airportCode);

                return airportCode;
            } else {
                throw new Error(`No airport found for ${cityName}`);
            }
        } catch (error) {
            console.error(`Error searching airport for ${cityName}:`, error.message);
            throw new Error(`Could not find airport code for ${cityName}. Please use airport codes like NYC, LON, DEL.`);
        }
    }

    async findAirports(cityName) {
        try {
            // Check local airport codes database first
            const normalizedCity = cityName.toLowerCase().trim();
            const results = [];

            // Check exact matches in our database
            // Replace airportCodes with extendedAirportCodes
            if (extendedAirportCodes[normalizedCity]) {
                results.push({
                    code: extendedAirportCodes[normalizedCity],
                    name: cityName.charAt(0).toUpperCase() + cityName.slice(1),
                    city: cityName
                });
            }

            // Check partial matches in our database
            // Replace airportCodes with extendedAirportCodes
            for (const [city, code] of Object.entries(extendedAirportCodes)) {
                if (city.includes(normalizedCity) || normalizedCity.includes(city)) {
                    // Don't add duplicates
                    if (!results.some(r => r.code === code)) {
                        results.push({
                            code: code,
                            name: city.charAt(0).toUpperCase() + city.slice(1),
                            city: city
                        });
                    }
                }
            }

            // If we have results from the database, return them now
            if (results.length > 0) {
                return results;
            }

            // The API code can stay as-is
            const response = await this.makeRequest('/v1/reference-data/locations', {
                keyword: cityName,
                subType: 'AIRPORT,CITY',
                'page[limit]': 5
            });

            if (response.data && response.data.data && response.data.data.length > 0) {
                return response.data.data.map(location => {
                    return {
                        code: location.iataCode,
                        name: location.name,
                        city: location.address?.cityName || location.name
                    };
                });
            }

            return [];
        } catch (error) {
            console.error(`Error finding airports for ${cityName}:`, error.message);
            throw new Error(`Could not find airports for ${cityName}.`);
        }
    }

    async searchFlights(origin, destination, departureDate, returnDate = null, adults = 1) {
        try {
            if (!origin || typeof origin !== 'string' || origin.length !== 3) {
                console.error(`Invalid origin code: "${origin}" (type: ${typeof origin})`);
                throw new Error(`Invalid origin airport code: ${origin}`);
            }

            if (!destination || typeof destination !== 'string' || destination.length !== 3) {
                console.error(`Invalid destination code: "${destination}" (type: ${typeof destination})`);
                throw new Error(`Invalid destination airport code: ${destination}`);
            }

            // Format dates to YYYY-MM-DD as required by API
            const formattedDepartDate = departureDate.split('T')[0];
            const formattedReturnDate = returnDate ? returnDate.split('T')[0] : null;

            console.log(`Searching flights: ${origin} -> ${destination} on ${formattedDepartDate}`);

            // Build the request parameters
            const params = {
                originLocationCode: origin,
                destinationLocationCode: destination,
                departureDate: formattedDepartDate,
                adults: adults,
                currencyCode: 'USD',
                max: 20  // Increased max results
            };

            // Add optional return date if provided
            if (formattedReturnDate) {
                params.returnDate = formattedReturnDate;
            }

            // Make the API request with correct endpoint and parameters
            const response = await this.makeRequest('/v2/shopping/flight-offers', params);

            console.log(`API Response status: ${response.status}, found ${response.data?.data?.length || 0} flights`);

            if (response.data && response.data.data && Array.isArray(response.data.data) && response.data.data.length > 0) {
                console.log(`Processing ${response.data.data.length} flight offers`);

                // Transform the API response to a more usable format
                return response.data.data.map(offer => {
                    try {
                        // Get price information
                        const price = offer.price?.total || 'Unknown';
                        const currency = offer.price?.currency || 'USD';

                        // Get airline info
                        const validatingAirline = offer.validatingAirlineCodes?.[0] || 'Unknown';

                        // Process outbound journey (first itinerary)
                        const outbound = offer.itineraries?.[0];
                        if (!outbound) {
                            throw new Error('Missing itinerary data');
                        }

                        // Get duration
                        const duration = this.formatDuration(outbound.duration);

                        // Process segments to count stops and get departure/arrival info
                        const segments = outbound.segments || [];
                        const stops = Math.max(0, segments.length - 1);

                        // Get departure and arrival details from first and last segment
                        const firstSegment = segments[0] || {};
                        const lastSegment = segments[segments.length - 1] || firstSegment;

                        const departureTime = firstSegment.departure?.at;
                        const arrivalTime = lastSegment.arrival?.at;

                        // Include full segment details
                        const segmentDetails = segments.map(segment => ({
                            departure: {
                                airport: segment.departure?.iataCode,
                                terminal: segment.departure?.terminal,
                                at: segment.departure?.at
                            },
                            arrival: {
                                airport: segment.arrival?.iataCode,
                                terminal: segment.arrival?.terminal,
                                at: segment.arrival?.at
                            },
                            carrierCode: segment.carrierCode,
                            flightNumber: segment.number,
                            duration: this.formatDuration(segment.duration),
                            aircraft: segment.aircraft?.code
                        }));

                        return {
                            id: offer.id,
                            price,
                            currency,
                            airline: validatingAirline,
                            duration: outbound.duration,
                            formattedDuration: duration,
                            stops,
                            departureTime,
                            arrivalTime,
                            segments: segmentDetails,
                            bookingUrl: this.generateBookingUrl(params.originLocationCode, params.destinationLocationCode,
                                params.departureDate, params.returnDate)
                        };
                    } catch (error) {
                        console.error(`Error processing flight offer ${offer.id}:`, error);
                        // Return minimal data for problematic offers
                        return {
                            id: offer.id || 'unknown',
                            price: offer.price?.total || 'Unknown',
                            currency: offer.price?.currency || 'USD',
                            error: `Processing error: ${error.message}`
                        };
                    }
                });
            } else {
                // Log detailed info about the empty results
                console.log('No flights found in API response.');
                console.log('Response meta:', JSON.stringify(response?.meta || {}, null, 2));
                console.log('Response warnings:', JSON.stringify(response?.warnings || [], null, 2));

                // Return empty array instead of mock data
                return [];
            }
        } catch (error) {
            console.error('Flight search error:', error.message);
            if (error.response) {
                console.error('API error details:', JSON.stringify({
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data
                }, null, 2));
            }
            // Return empty array instead of mock data
            return [];
        }
    }

    generateBookingUrl(origin, destination, departureDate, returnDate = null) {
        // Generate affiliate booking URLs (replace with your affiliate links)
        const baseUrl = 'https://www.skyscanner.com/transport/flights';
        const dateStr = departureDate.replace(/-/g, '');
        const returnStr = returnDate ? returnDate.replace(/-/g, '') : '';

        if (returnDate) {
            return `${baseUrl}/${origin}/${destination}/${dateStr}/${returnStr}/?adults=1&children=0&adultsv2=1&childrenv2=&infants=0&cabinclass=economy&rtn=1&preferdirects=false&outboundaltsenabled=false&inboundaltsenabled=false`;
        } else {
            return `${baseUrl}/${origin}/${destination}/${dateStr}/?adults=1&children=0&adultsv2=1&childrenv2=&infants=0&cabinclass=economy&rtn=0&preferdirects=false&outboundaltsenabled=false&inboundaltsenabled=false`;
        }
    }

    getMockFlightData(origin, destination) {
        // Mock data for development/testing with better logging
        console.log(`Generating mock data for ${origin} to ${destination}`);

        // Current date for departure
        const departureDate = new Date().toISOString().split('T')[0];

        const mockFlights = [
            {
                id: 'mock-1',
                price: Math.floor(Math.random() * 500) + 200,
                currency: 'USD',
                airline: 'AI',
                duration: 'PT2H30M',
                formattedDuration: '2h 30m', // Add formatted duration
                stops: 0,
                departureTime: new Date().toISOString(),
                arrivalTime: new Date(Date.now() + 2.5 * 60 * 60 * 1000).toISOString(),
                bookingUrl: this.generateBookingUrl(origin, destination, departureDate)
            },
            {
                id: 'mock-2',
                price: Math.floor(Math.random() * 400) + 250,
                currency: 'USD',
                airline: 'UK',
                duration: 'PT3H15M',
                formattedDuration: '3h 15m', // Add formatted duration
                stops: 1,
                departureTime: new Date().toISOString(),
                arrivalTime: new Date(Date.now() + 3.25 * 60 * 60 * 1000).toISOString(),
                bookingUrl: this.generateBookingUrl(origin, destination, departureDate)
            }
        ];

        console.log(`Generated ${mockFlights.length} mock flights`);
        return mockFlights;
    }

    async getFlightPrice(origin, destination, departureDate, returnDate = null) {
        try {
            const flights = await this.searchFlights(origin, destination, departureDate, returnDate);

            if (flights.length === 0) {
                throw new Error('No flights found');
            }

            // Return the cheapest flight
            const cheapestFlight = flights[0];
            return {
                price: cheapestFlight.price,
                currency: cheapestFlight.currency,
                airline: cheapestFlight.airline,
                bookingUrl: cheapestFlight.bookingUrl,
                details: {
                    stops: cheapestFlight.stops,
                    duration: cheapestFlight.duration,
                    departureTime: cheapestFlight.departureTime,
                    arrivalTime: cheapestFlight.arrivalTime
                }
            };
        } catch (error) {
            console.error('Error getting flight price:', error.message);
            throw error;
        }
    }

    formatDuration(duration) {
        if (!duration) return "Unknown";

        try {
            // PT14H15M format - extract hours and minutes
            const regex = /PT(?:(\d+)H)?(?:(\d+)M)?/;
            const match = duration.match(regex);

            if (!match) return duration;

            const hours = match[1] ? parseInt(match[1], 10) : 0;
            const minutes = match[2] ? parseInt(match[2], 10) : 0;

            if (hours > 0 && minutes > 0) {
                return `${hours}h ${minutes}m`;
            } else if (hours > 0) {
                return `${hours}h`;
            } else if (minutes > 0) {
                return `${minutes}m`;
            } else {
                return "0m";
            }
        } catch (error) {
            console.error("Error formatting duration:", error);
            return duration || "Unknown";
        }
    }

    async validateRoute(origin, destination) {
        try {
            await this.searchAirport(origin);
            await this.searchAirport(destination);
            return true;
        } catch (error) {
            throw new Error(`Invalid route: ${error.message}`);
        }
    }

    getCheapestFlights(flights, limit = 5) {
        if (!Array.isArray(flights) || flights.length === 0) {
            return [];
        }

        try {
            // Sort by price (assuming price is already a numeric string)
            const sortedFlights = [...flights].sort((a, b) => {
                const priceA = parseFloat(a.price) || Infinity;
                const priceB = parseFloat(b.price) || Infinity;
                return priceA - priceB;
            });

            return sortedFlights.slice(0, limit);
        } catch (error) {
            console.error("Error getting cheapest flights:", error);
            return [];
        }
    }

    // Alternative APIs for redundancy (implement as needed)
    async searchFlightsSkyscanner(origin, destination, departureDate) {
        // Implement Skyscanner API as backup
        // This would require separate API credentials
        throw new Error('Skyscanner API not implemented yet');
    }

    async searchFlightsGoogle(origin, destination, departureDate) {
        // Implement Google Flights API as backup
        // This would require separate API credentials  
        throw new Error('Google Flights API not implemented yet');
    }
}

module.exports = FlightAPI;
