import axios from "axios";
import crypto from "crypto";

const LINE_API = "https://api.line.me/v2/bot/message";

export async function replyMessage(
  replyToken: string,
  text: string
): Promise<void> {
  await axios.post(
    `${LINE_API}/reply`,
    {
      replyToken,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

export async function pushMessage(text: string): Promise<void> {
  await axios.post(
    `${LINE_API}/push`,
    {
      to: process.env.LINE_USER_ID,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

export async function pushImageMessage(imageUrl: string): Promise<void> {
  await axios.post(
    `${LINE_API}/push`,
    {
      to: process.env.LINE_USER_ID,
      messages: [
        { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// Sends image + text in a single reply call (2 messages).
// Used for on-demand photo requests from the LINE chat.
export async function replyImageMessage(
  replyToken: string,
  imageUrl: string,
  text: string
): Promise<void> {
  await axios.post(
    `${LINE_API}/reply`,
    {
      replyToken,
      messages: [
        { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl },
        { type: "text", text },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

export function verifyLineSignature(
  body: string,
  signature: string
): boolean {
  const hash = crypto
    .createHmac("SHA256", process.env.LINE_CHANNEL_SECRET!)
    .update(body)
    .digest("base64");
  return hash === signature;
}
