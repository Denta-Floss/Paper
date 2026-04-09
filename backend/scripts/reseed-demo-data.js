const backend = require('../server.js');

async function main() {
  try {
    await backend.resetAndSeedDemoData();
    console.log('Paper demo data has been reset and reseeded.');
  } finally {
    await backend.closeDb();
  }
}

main().catch((error) => {
  console.error('Failed to reseed demo data:', error);
  process.exit(1);
});
