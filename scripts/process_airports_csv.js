const fs = require('fs');
const path = require('path');
const csv = require('csv-parser'); // You may need to install this: npm install csv-parser

// Path to your CSV file
const csvFilePath = path.join(__dirname, '..', 'data', 'airports.csv');
// Output file path
const outputPath = path.join(__dirname, '..', 'data', 'airportCodesExtended.js');

// Store processed data
const airportCodes = {};
const processedCities = new Set();

console.log('Starting airport CSV processing...');

// Read the original airportCodes.js to preserve existing entries
try {
    const originalCodesPath = path.join(__dirname, '..', 'data', 'airportCodes.js');
    const originalContent = fs.readFileSync(originalCodesPath, 'utf8');

    // Extract existing entries using regex
    const regex = /"([^"]+)":\s*"([^"]+)"/g;
    let match;

    while ((match = regex.exec(originalContent)) !== null) {
        const city = match[1];
        const code = match[2];
        airportCodes[city] = code;
        processedCities.add(city.toLowerCase());
        processedCities.add(code.toLowerCase());
    }

    console.log(`Loaded ${Object.keys(airportCodes).length} existing airport codes`);
} catch (error) {
    console.error('Error reading existing airportCodes.js:', error);
}

// Process the CSV file
fs.createReadStream(csvFilePath)
    .pipe(csv())
    .on('data', (row) => {
        try {
            // Skip rows without IATA code
            if (!row.IATA || row.IATA === '\\N' || row.IATA.length !== 3) {
                return;
            }

            const iataCode = row.IATA.trim();
            let cityName = row.City ? row.City.trim().toLowerCase() : '';

            // Skip if we already have this city or code in our processed set
            if (!cityName || processedCities.has(cityName) || processedCities.has(iataCode.toLowerCase())) {
                return;
            }

            // Add the city with its code
            airportCodes[cityName] = iataCode;
            processedCities.add(cityName);
            processedCities.add(iataCode.toLowerCase());

            // For bigger cities, also add with country for disambiguation
            if (row.Country && ['United States', 'China', 'India', 'Russia', 'Brazil', 'United Kingdom', 'Spain', 'Mexico'].includes(row.Country)) {
                const cityWithCountry = `${cityName}, ${row.Country.toLowerCase()}`;
                if (!processedCities.has(cityWithCountry)) {
                    airportCodes[cityWithCountry] = iataCode;
                    processedCities.add(cityWithCountry);
                }
            }
        } catch (error) {
            console.error('Error processing row:', error, row);
        }
    })
    .on('end', () => {
        // Generate the output JavaScript file
        const output = `/**
 * Extended Airport code mapping for cities worldwide
 * Format: { "city name lowercase": "IATA_CODE" }
 * Auto-generated from airports.csv on ${new Date().toISOString()}
 */
const airportCodes = ${JSON.stringify(airportCodes, null, 2)
                .replace(/"([^"]+)":/g, '"$1":')
                .replace(/\n/g, '\n  ')};

module.exports = airportCodes;
`;

        fs.writeFileSync(outputPath, output);
        console.log(`Successfully processed ${Object.keys(airportCodes).length} airports`);
        console.log(`Output saved to ${outputPath}`);
    });