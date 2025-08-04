// src/config/firebase.js
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import admin from "firebase-admin";
import fs from "fs";

// Handle __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load service account JSON (adjust the filename if needed)
const serviceAccountPath = path.resolve(__dirname, "../../service-account-key.json");
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

// Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export default admin;
