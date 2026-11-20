require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { createBackups } = require('../kernel/backup');

const dbPath = String(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'paper.db'));
// Beside the database by default, as the server's own scheduled backups are.
const backupDir = String(process.env.PAPER_BACKUP_DIR || path.join(path.dirname(path.resolve(dbPath)), 'backups'));
const keep = Number(process.env.PAPER_BACKUP_KEEP || 14);
const bucketName = process.env.PAPER_S3_BUCKET_NAME;
// Namespace each on-prem client's uploads so they don't overwrite each other.
const clientId = String(process.env.PAPER_CLIENT_ID || 'default');

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function uploadToS3(filePath, fileName) {
  if (!bucketName) {
    console.log('PAPER_S3_BUCKET_NAME is not set. Skipping S3 upload.');
    return;
  }

  const s3Config = {
    region: process.env.PAPER_S3_REGION || 'us-east-1',
  };

  // If local overrides exist
  if (process.env.S3_ENDPOINT) {
    s3Config.endpoint = process.env.S3_ENDPOINT;
    s3Config.forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';
  }

  const s3Client = new S3Client(s3Config);
  const fileStream = fs.createReadStream(filePath);

  const key = `backups/${clientId}/${fileName}`;
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: fileStream,
  });

  try {
    await s3Client.send(command);
    console.log(`Successfully uploaded backup to S3: s3://${bucketName}/${key}`);
  } catch (error) {
    console.error(`Failed to upload to S3:`, error);
    throw error;
  }
}

// A hot backup: VACUUM INTO on a connection of its own, then integrity_check
// (kernel/backup.js). This used to be fs.copyFileSync(paper.db), which in WAL
// mode leaves out every write still in paper.db-wal and can catch the file
// mid-write (B56).
async function main() {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file not found at ${dbPath}`);
  }
  const backups = createBackups({ dbPath, dir: backupDir, keep });
  const made = await backups.backup();
  const latestBackup = path.join(backupDir, 'paper-latest.db');
  // From the checked copy, not from the live file.
  fs.copyFileSync(made.path, latestBackup);

  console.log(`Created local backups (integrity ${made.integrity}, ${made.bytes} bytes, ${made.durationMs} ms):\n- ${made.path}\n- ${latestBackup}`);
  if (made.removed.length) console.log(`Removed older backups: ${made.removed.join(', ')}`);

  await uploadToS3(made.path, made.file);
  await uploadToS3(latestBackup, 'paper-latest.db');
}

main().catch((error) => {
  console.error('Backup failed:', error.message);
  process.exit(1);
});
