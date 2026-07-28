import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the built site works on GitHub Pages project URLs
export default defineConfig({
  plugins: [react()],
  base: "./",
});
