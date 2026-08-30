import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import multer from "multer";

import { multipartOnly } from "../../apps/runner/dist/services/staged-attachment-request.js";

const root = process.argv[2];
const destination = join(root, "crashed-upload");
const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, callback) => {
      await mkdir(destination, { recursive: true });
      callback(null, destination);
    },
    filename: (_req, file, callback) => callback(null, file.originalname)
  })
}).array("attachments", 1);

const app = express();
app.post("/upload", multipartOnly(upload), (req, _res) => {
  process.stdout.write(`uploaded:${req.files[0].path}\n`);
});

const server = app.listen(0, "127.0.0.1", () => {
  process.stdout.write(`port:${server.address().port}\n`);
});
