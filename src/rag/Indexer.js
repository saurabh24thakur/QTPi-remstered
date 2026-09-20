import { QdrantClient } from '@qdrant/js-client-rest';
import chalk from 'chalk';



export function createVectorStore(config) {

  const qdrantUrl = config.get('qdrantUrl') || 'http://localhost:6333';
  const qdrantKey = config.get('qdrantKey');


  const collectionName = 'qtpi_' + hashString(process.cwd());


  const client = new QdrantClient({
    url: qdrantUrl,
    apiKey: qdrantKey || undefined,
  });



  async function ensureCollection(vectorSize) {
    try {
      const collections = await client.getCollections();
      const exists = collections.collections.some(c => c.name === collectionName);

      if (!exists) {
        // Create it
        await client.createCollection(collectionName, {
          vectors: {
            size: vectorSize,
            distance: 'Cosine',  
          },
        });
        console.log(chalk.gray(`  Created Qdrant collection: ${collectionName}`));
      }
    } catch (error) {
      throw new Error(
        `Could not connect to Qdrant at ${qdrantUrl}\n` +
        `Make sure Qdrant is running:\n` +
        `  docker run -p 6333:6333 qdrant/qdrant\n` +
        `Or set Qdrant Cloud URL: qtpi config --qdrant-url YOUR_URL\n\n` +
        `Error: ${error.message}`
      );
    }
  }



  async function saveChunks(chunks) {
    if (chunks.length === 0) return;

    
    await ensureCollection(chunks[0].embedding.length);

   
    try {
      await client.delete(collectionName, {
        filter: {}, 
        wait: true,
      });
    } catch {
      
    }

    // Upload in batches of 100 (Qdrant handles this efficiently)
    const BATCH_SIZE = 100;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);

      const points = batch.map((chunk, index) => ({
        id: i + index,  // Unique numeric ID
        vector: chunk.embedding,
        payload: {
          filePath: chunk.filePath,
          content: chunk.content,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        },
      }));

      await client.upsert(collectionName, {
        points: points,
        wait: true,
      });
    }
  }


  async function search(queryEmbedding, topK = 5) {
    try {
      const results = await client.search(collectionName, {
        vector: queryEmbedding,
        limit: topK,
        with_payload: true,
      });

      // Convert Qdrant results to our standard format
      return results.map(result => ({
        filePath: result.payload.filePath,
        content: result.payload.content,
        startLine: result.payload.startLine,
        endLine: result.payload.endLine,
        score: result.score,
      }));
    } catch (error) {
      throw new Error(`Qdrant search failed: ${error.message}`);
    }
  }



  async function isIndexed() {
    try {
      const collections = await client.getCollections();
      const exists = collections.collections.some(c => c.name === collectionName);

      if (!exists) return false;

      const info = await client.getCollection(collectionName);
      return info.points_count > 0;
    } catch {
      return false;
    }
  }


  return {
    saveChunks,
    search,
    isIndexed,
  };
}



function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;  // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}