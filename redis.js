const { createClient } = require('redis');

// Create and configure the Redis client
const client = createClient({
    url: 'redis://64.227.129.239:6379',
});

const subscriber = client.duplicate();
const publisher = client.duplicate();

client.on('connect', () => {
    console.log('Connected to Redis successfully');
});

subscriber.on('connect', () => {
    console.log('Connected to Redis subscriber');
});

publisher.on('connect', () => {
    console.log('Connected to Redis publisher');
});

// Error handling
client.on('error', (err) => {
    console.error('Redis Client Error', err);
});

subscriber.on('error', (err) => {
    console.error('Redis Subscriber Error', err);
});

publisher.on('error', (err) => {
    console.error('Redis Publisher Error', err);
});

// Connect to the Redis server
client.connect().catch(console.error);
subscriber.connect().catch(console.error);
publisher.connect().catch(console.error);

// Export the client
module.exports = {
    client,
    subscriber,
    publisher
};
