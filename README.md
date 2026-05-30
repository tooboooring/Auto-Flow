# 🌊 Auto Flow Chrome Extension

> **A powerful, lightweight Chrome/Chromium side panel extension for bulk image generation via Google Labs Flow.**
>
> ✨ *Note: This project is Vibe Coded.*

Auto Flow enables sequential bulk generation, automation, and auto-downloading of images directly from the **Google Labs Flow API** into local folders. 

By utilizing your active browser session (seamlessly managing session tokens and automated reCAPTCHA), it completely eliminates the need for manual clicking and saving. This tool is designed to save countless hours in creative, historical, and video production workflows.

---

## 🚀 Features

- **⚡ Bulk Generation**: Enter prompts manually or upload bulk lists via `.txt`, `.csv`, or `.tsv` files.
- **🔌 Direct API Integration**: Communicates directly with the Google Labs Flow API using your secure, active session.
- **💾 Auto-Download & Formatting**: Images are automatically saved to customized local folders with sequential file naming.
- **🛡️ Fault-Tolerant & Resilient**: Built-in exponential backoff retry system that automatically recovers from `HTTP 429` (Too Many Requests), temporary network drops, and handles daily quota exhaustion.
- **🔄 State Management & Resume**: Tracks pending, completed, and failed generations. Export and import your progress manifest to easily switch browsers or resume sessions later.
- **🧩 Prompt Variables**: Inject dynamic variables across your prompt list for rapid iteration and consistency.

---

## 🛠️ Installation

Auto Flow is an open-source tool and is designed to be loaded locally as an unpacked extension.

1. Clone or download this repository to your local machine.
2. Open Chrome (or any Chromium-based browser) and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle in the top right corner.
4. Click **Load unpacked** and select the `auto-flow-chrome` directory.

---

## 📖 Usage Guide

1. Go to [Google Labs Flow](https://labs.google/fx/tools/flow/) and log in. Ensure you have an active project open.
2. Click the **Auto Flow** extension icon in your browser toolbar to open the side panel.
3. **Load Prompts**: Upload a file with your prompts or type them in manually.
4. **Configure Settings**: Select your preferred AI Model, Aspect Ratio, and File Naming convention.
5. **Set Custom Folder**: (Optional) Define a custom download folder name to organize your batches.
6. Click **Start Generating**. 

⚠️ **Important**: Do not close the Google Labs Flow tab while the extension is generating. The extension relies on this active tab to authenticate requests.

---

## 📝 License

This project is licensed under the MIT License. Feel free to fork, modify, and contribute!
