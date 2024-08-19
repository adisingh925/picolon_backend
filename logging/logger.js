const axios = require('axios');
require("dotenv").config();

async function createLog(level, message, context = {}) {
    const timestamp = new Date().toISOString();
    const contextString = Object.entries(context).map(([key, value]) => `${key}=${value}`).join(', ');

    // Format the log as a single line string
    const logString = `[${timestamp}] [${level.toUpperCase()}] ${message}${contextString ? ' | ' + contextString : ''}`;

    // Output the log (for demonstration, we just log it to the console)
    console.log(logString);

    // Optionally, you might want to save the log to a file or send it to a logging server
    // await saveLogToFile(logString);
    // await sendLogToServer(logString);
}

module.exports = createLog;
