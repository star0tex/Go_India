//src/models/DriverDoc.js

import mongoose from "mongoose";

const driverDocSchema = new mongoose.Schema(
  {
    userId: {
  type: String, // ✅ Instead of ObjectId
      ref: "User",
      required: true,
    },

    // 📄 Type of document: Aadhaar, PAN, DL, etc.
    docType: {
      type: String,
      required: true,
    },

    // 📂 Path to the uploaded file (local or Cloudinary URL)
    url: {
      type: String,
      required: true,
    },

    // ✅ Document verification status
    status: {
      type: String,
      enum: ["pending", "verified", "rejected"],
      default: "pending",
    },

    // 🗒️ Admin remarks (optional)
    remarks: {
      type: String,
      default: "",
    },

    // 🔍 Text extracted using OCR (Google ML Kit or similar)
    extractedData: {
      type: String,
    },
  },
  { timestamps: true }
);

const DriverDoc = mongoose.model("DriverDoc", driverDocSchema);
export default DriverDoc;
