import { saveToInbox } from "../vault";

const REPLIES = [
  "จดให้แล้วนะ~ 📝",
  "โอเค เก็บไว้ให้แล้ว",
  "บันทึกแล้ว ไม่หายไปไหนหรอก",
  "โอเค จดเลย ✍️",
  "เก็บไว้ใน inbox แล้วนะ~",
  "ได้เลย บันทึกให้แล้ว 📌",
];

export async function handleCapture(text: string): Promise<string> {
  await saveToInbox(text);
  return REPLIES[Math.floor(Math.random() * REPLIES.length)];
}
