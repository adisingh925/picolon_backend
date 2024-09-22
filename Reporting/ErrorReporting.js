const axios = require('axios');

async function postToDiscord(body) {

    const USER_QUERY = 'user-query';
    const SERVER_ERROR = 'server-error';
    const UI_ERROR = 'ui-error';
    const GENERAL = 'general';

    const webhookUrls = {
        [USER_QUERY]: 'https://discord.com/api/webhooks/1287347063536881664/u34TvWxS61JYOuR7qWTles-G0c1rYSsmIjKg5C80tof37kt9pQ_gVIbb1FcX-xC7qlhu',
        [SERVER_ERROR]: 'https://discord.com/api/webhooks/1287347180998492170/OV-TaYd2PzNXeAs5TcTBc5S7-43X6yXxi_qJzshUnV7XUO6lgbP7wGmUTjzpxqtLLLFD',
        [UI_ERROR]: 'https://discord.com/api/webhooks/1287347257556992000/pOB7ELm64nAWTsrabjrx5r7kAyORNAE_xCEo3dm4_QVlAOPXSRLKG1I38yVCfFuuxWC0',
        [GENERAL]: 'https://discord.com/api/webhooks/1287361536586944564/tPz_UNv6m7NYPxAJUMlJDR3ClLrV1UiTnaWc44AO80bOITNebXNNOtSbeChMdRBE2efz'
    };

    try {
        // Define the embed structure based on the type
        let payload;

        switch (body.type) {
            case USER_QUERY:
                payload = {
                    embeds: [
                        {
                            color: 3447003, // Blue color
                            fields: [
                                {
                                    name: "Query",
                                    value: `\`\`\`${body.message}\`\`\``
                                }
                            ],
                            timestamp: new Date().toISOString()
                        }
                    ]
                };

                break;

            case SERVER_ERROR:
                payload = {
                    embeds: [
                        {
                            color: 16711680, // Red color for error
                            title: body.title,
                            fields: [
                                {
                                    name: "Error Message",
                                    value: `\`\`\`${body.message}\`\`\``
                                },
                                {
                                    name: "Stack Trace",
                                    value: `\`\`\`${body.stackTrace || "No stack trace available"}\`\`\``
                                }
                            ],
                            timestamp: new Date().toISOString()
                        }
                    ]
                };

                break;

            case UI_ERROR:
                payload = {
                    embeds: [
                        {
                            color: 16711680, // Yellow color for warning
                            fields: [
                                {
                                    name: "Error Message",
                                    value: `\`\`\`${body.message}\`\`\``
                                },
                                {
                                    name: "Stack Trace",
                                    value: `\`\`\`${body.stackTrace || "No stack trace available"}\`\`\``
                                }
                            ],
                            timestamp: new Date().toISOString()
                        }
                    ]
                };

                break;

            default: throw new Error("Invalid message type. Use 'user-queries', 'server-error', or 'ui-error'.");
        }

        // Send the payload to the Discord webhook
        await axios.post(webhookUrls[body.type], payload);
        console.log(`${body.type} posted to Discord successfully.`);
    } catch (postError) {
        console.error('Failed to post to Discord:', postError);
    }
}

// Export the function for use in other modules
module.exports = {
    postToDiscord
};
