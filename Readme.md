AeroWizard Flight Tracker Bot
AeroWizard is a Telegram bot that helps users track flights, monitor price changes, and receive real-time flight status updates.

Features

Flight Search: Find the most affordable flights between any two destinations
Price Tracking: Monitor flight prices and get notifications when prices drop
Flight Status Tracking: Track specific flights by route or flight number
Status Updates: Receive notifications for schedule changes, delays, gate changes, and more
Multiple Airport Selection: Support for cities with multiple airports
Weekly Summaries: Get weekly digests of your tracked flights and price alerts

Getting Started

Prerequisites
Node.js (v16.x or higher)
Firebase account
Amadeus API credentials
Telegram Bot token (from BotFather)

Installation

Clone this repository:

git clone https://github.com/yourusername/flight_tracker_bot.git
cd flight_tracker_bot

Install dependencies:

npm install

Configure your environment variables by creating a .env file:

# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
WEBHOOK_URL=https://yourdomain.com/webhook
BOT_USERNAME=your_bot_username

# Flight API Configuration
AMADEUS_API_KEY=your_amadeus_api_key
AMADEUS_API_SECRET=your_amadeus_api_secret

# Firebase Configuration
FIREBASE_PROJECT_ID=your_firebase_project_id

# Server Configuration
PORT=3000
NODE_ENV=development

Process airport data:

node scripts/process_airports_csv.js

Start the bot:

npm start

Development Mode
To run the bot in development mode with auto-reloading:

npm run dev

Usage
Bot Commands
/start - Initialize the bot and see the welcome message
/search - Start flight search process
/track - Start flight tracking process
/myflights - View your tracked flights
/premium - See premium membership options
/share - Get shareable link for the bot
/help - Display help information
/debug - (Development) Show current user state
Main Menu Options
🔍 Search Flights - Find affordable flights between destinations
💰 My Price Alerts - View and manage your price tracking alerts
✈️ My Tracked Flights - View and manage flights you're tracking
🛫 Track Flights - Track a new flight by route or flight number
❓ Help - Display help information
⭐ Premium - Premium membership options
🔗 Share - Share the bot with others
Project Structure
services - Core service modules
flightAPI.js - Handles Amadeus API interactions
database.js - Firebase database operations
flightTracker.js - Flight status tracking functionality
priceMonitor.js - Price monitoring and alerts
data - Data files
airports.csv - Airport database
airportCodes.js - Processed airport codes
scripts - Utility scripts
process_airports_csv.js - Process the airports CSV into a usable format
index.js - Main application entry point
Scheduled Tasks
Price monitoring runs every 4 hours
Flight status checks run every 30 minutes
Deployment
For production deployment:

Set NODE_ENV=production in your environment
Configure your webhook URL
Deploy to your hosting provider (Firebase, Heroku, etc.)
Ensure the webhook endpoint is accessible
Contributing
Fork the repository
Create your feature branch (git checkout -b feature/amazing-feature)
Commit your changes (git commit -m 'Add some amazing feature')
Push to the branch (git push origin feature/amazing-feature)
Open a Pull Request
License
This project is licensed under the MIT License - see the LICENSE file for details.

Acknowledgments
Airport data from OurAirports
Flight data provided by Amadeus API
Built with Node.js and Telegram Bot API

Note: This bot is for educational purposes only. Always verify flight information with the official airline.