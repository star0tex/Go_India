// DriverDoc.js
import mongoose from "mongoose";

const driverDocSchema = new mongoose.Schema(
  {
<<<<<<< HEAD
    userId: {
  type: String,
  ref: "User",
  required: true,
},
=======
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
>>>>>>> 6049df7ec5642d30643132f7ca7502dee8f10538

    docType: { type: String, required: true, trim: true },

    // Front / Back
    side: { type: String, enum: ["front", "back"], default: "front" },

    // Optional but useful for filtering/reporting
    vehicleType: { type: String, trim: true },

    // Image path or URL
    url: { type: String, default: null },

    status: {
      type: String,
      enum: ["pending", "verified", "rejected", "approved"],
      default: "pending",
    },

    remarks: { type: String, default: "" },

    // Make this flexible so we can store any OCR fields per document/side
    extractedData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    imageDeleted: { type: Boolean, default: false },
    imageDeletedAt: { type: Date },

    // When the driver requested a resend / re-verification (set by driver)
    // This field was added to support doc.resendRequestedAt = new Date() in controllers.
    resendRequestedAt: { type: Date, default: null },

    // Optional: track number of times driver requested resend (helpful for audit)
    resendCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Optional: small index to quickly find pending docs or recently resent docs
driverDocSchema.index({ status: 1 });
driverDocSchema.index({ resendRequestedAt: -1 });

export default mongoose.model("DriverDoc", driverDocSchema);
