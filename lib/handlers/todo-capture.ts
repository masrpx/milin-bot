import { getInbox, saveInbox, generateTodoId } from "../todo";

export async function handleTodoCapture(text: string): Promise<string> {
  const { items, sha } = await getInbox();
  const newItem = { id: generateTodoId(), text, addedAt: new Date().toISOString() };
  await saveInbox([...items, newItem], sha);
  return "จดไว้แล้ว ✓";
}
