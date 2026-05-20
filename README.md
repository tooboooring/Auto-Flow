# Auto Flow Chrome Extension

A lightweight, powerful Chrome/Chromium extension side panel that enables sequential **bulk generation**, **automation**, and **auto-downloading** of images directly from the **Google Labs Flow API** into local folders.

By utilizing your active browser session (session token and automated reCAPTCHA management), it completely eliminates the need for manual clicking and saving, saving countless hours in creative and video production workflows.

## Features
- **Bulk Generation**: Enter prompts manually or upload a `.txt` / `.csv` file.
- **Direct API Integration**: Communicates directly with the Google Labs Flow API via your active session.
- **Auto-Download**: Images are automatically saved to a `Flow_Images` folder sequentially.
- **Session Management**: Automatically handles auth tokens and reCAPTCHA.
- **Rate-Limit & Error Recovery**: Built-in exponential backoff retry system that automatically recovers from `HTTP 429` (Too Many Requests) and daily account quota exhaustion.

## Installation

This extension is not currently published on the Chrome Web Store. To install it locally:

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top right corner).
4. Click **Load unpacked** and select the `auto-flow-chrome` directory.

## Usage

1. Go to [Google Labs Flow](https://labs.google/fx/tools/flow/) and log in (make sure a project is open).
2. Click the **Auto Flow** extension icon in your Chrome toolbar to open the side panel.
3. Upload a file with prompts (or type them in).
4. Select your preferred model and aspect ratio.
5. Click **Start Generating**. 

> **Note**: Do not close the Google Labs Flow tab while the extension is generating.
## License

This project is licensed under the MIT License.
