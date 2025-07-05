/**
 * Airport code mapping for common cities
 * Format: { "city name lowercase": "IATA_CODE" }
 */
const airportCodes = {
    // India
    "delhi": "DEL",
    "mumbai": "BOM",
    "bangalore": "BLR",
    "chennai": "MAA",
    "kolkata": "CCU",
    "hyderabad": "HYD",
    "ahmedabad": "AMD",
    "guwahati": "GAU",
    "cochin": "COK",
    "pune": "PNQ",

    // International
    "london": "LHR",  // Keep the main one
    "london heathrow": "LHR",
    "london gatwick": "LGW",
    "london city": "LCY",
    "london stansted": "STN",
    "london luton": "LTN",
    "new york": "JFK",  // Keep the main one
    "new york jfk": "JFK",
    "new york lga": "LGA",  // LaGuardia
    "new york ewr": "EWR",  // Newark
    "dubai": "DXB",
    "singapore": "SIN",
    "bangkok": "BKK",
    "paris": "CDG",
    "amsterdam": "AMS",
    "frankfurt": "FRA",
    "hong kong": "HKG",
    "sydney": "SYD",

    // Add more as needed
};

module.exports = airportCodes;
