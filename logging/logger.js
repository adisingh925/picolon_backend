const postLogToGoogleChat = require("./postLogsToGoogleChat");

const handleLog = (log) => {
    postLogToGoogleChat(log);
    console.log(log);
}

module.exports = handleLog;