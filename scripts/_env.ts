// Side-effect import that loads .env.local. Import this FIRST in scripts that
// import modules reading process.env at load time (e.g. lib/finance.ts), so the
// env is populated before those modules evaluate.
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
