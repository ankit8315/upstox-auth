const protobuf = require("protobufjs");
const pako = require("pako");
const path = require("path");

let FeedResponse;

async function loadProto() {
  const root = await protobuf.load(path.join(__dirname, "upstox.proto"));
  FeedResponse = root.lookupType("FeedResponse");
}

function decodeMessage(buffer) {
  try {
    // decompress if gzipped
    let decompressed;

    try {
      decompressed = pako.inflate(buffer);
    } catch {
      decompressed = buffer;
    }

    const message = FeedResponse.decode(decompressed);
    return FeedResponse.toObject(message, {
      longs: Number,
      enums: String,
      defaults: true
    });

  } catch (err) {
    return null;
  }
}

module.exports = { loadProto, decodeMessage };