const axios = require('axios');
require("dotenv").config();

async function postLogToGoogleChat(errorMessage) {
    console.log(process.env.NODE_ENV);
    if (process.env.NODE_ENV === 'production') {
        try {
            await axios.post(
                `https://chat.googleapis.com/v1/spaces/${process.env.LOG_UPLOADER_SPACE_ID}/messages`,
                {
                    text: errorMessage
                },
                {
                    params: {
                        key: process.env.GOOGLE_API_KEY,
                        token: process.env.LOG_UPLOADER_TOKEN
                    },
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );
        } catch (error) {
            console.error('Error posting to Google Chat:', error);
        }
    }
}

module.exports = postLogToGoogleChat;
