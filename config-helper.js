const functions = require('firebase-functions');

// Load environment variables from .env file in development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// Get config values, with .env as fallback
exports.config = {
  telegram: {
    token: process.env.NODE_ENV === 'production'
      ? functions.config().telegram?.token
      : process.env.TELEGRAM_BOT_TOKEN,
    webhook: process.env.NODE_ENV === 'production'
      ? functions.config().telegram?.webhook
      : process.env.WEBHOOK_URL,
    username: process.env.NODE_ENV === 'production'
      ? functions.config().telegram?.username
      : process.env.BOT_USERNAME
  },
  amadeus: {
    key: process.env.NODE_ENV === 'production'
      ? functions.config().amadeus?.key
      : process.env.AMADEUS_API_KEY,
    secret: process.env.NODE_ENV === 'production'
      ? functions.config().amadeus?.secret
      : process.env.AMADEUS_API_SECRET
  }
};