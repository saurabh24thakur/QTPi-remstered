// test-qdrant.js — delete after testing
import { QdrantClient } from '@qdrant/js-client-rest';
import { getConfig } from './src/config/ConfigManager.js';

const client = new QdrantClient({
  url: getConfig('qdrantUrl') || 'http://localhost:6333',
  apiKey: getConfig('qdrantKey') || undefined,
});

try {
  const result = await client.getCollections();
  console.log('✅ Connected to Qdrant successfully!');
  console.log('Collections:', result.collections);
} catch (error) {
  console.error('❌ Could not connect to Qdrant:', error.message);
}


// eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6Y2I3NzAzZmUtOGQxOS00YzNkLTg1MzEtYWI3NmJmODJmMTRlIn0.8B2pip0qD1rE78Vx0yD15u-CY-jztCwjw9VvPvLdPzo
// https://445be320-1c52-4fce-8d7e-9966f3d3fca1.eu-west-2-0.aws.cloud.qdrant.io