# co-opt (Collaborative Optical Tool)

`co-opt` is a web-based application designed to visualize and prototype optical systems. It provides an intuitive interface to manage lens parameters and evaluate optical configurations in the browser.

## 🚀 Overview
The goal of `co-opt` is to make optical design more accessible and collaborative. Unlike traditional proprietary software, `co-opt` runs entirely in the browser and uses an open data format, making it easy to share and iterate on designs.

## 🛠 Hackable JSON Data Format
One of the core philosophies of `co-opt` is its **"Hackability."** All optical systems are handled as simple **JSON files**. This design choice provides several advantages for engineers:
- **Version Control:** Since designs are plain text, you can easily track changes and manage your lens configurations using **Git**.
- **Script Integration:** You can programmatically generate, modify, or analyze lens data using your favorite languages like **Python** or **JavaScript**.
- **Portability:** Effortlessly share configurations by simply copying the JSON string or sharing a URL.

## 🕹 Usage
1. Open [https://yassan8.github.io/co-opt/](https://yassan8.github.io/co-opt/) in a web browser.
2. **Note:** If you don't see any data on startup, click the **"Clear Cache"** button to load the default sample lens data.
3. Use the table interface to add, delete, and modify lens parameters (radius, thickness, material, etc.) and visualize the resulting light paths.

## 📦 GitHub Pages (docs/)
This repo publishes the web app via GitHub Pages using the `docs/` folder.

- `docs/` is treated as a generated build artifact.
- To regenerate it from the repo root:
	- `node tools/build-pages-docs.mjs`
- Quick sanity check that a few key files match:
	- `node testing/quick-cross-test.js`

Note: the build script deletes and recreates `docs/`. If you use a custom domain, keep `docs/CNAME` safe (re-add it after build, or adjust the script to preserve it).

## ✨ Features
- **Dynamic Lens Management:** Add and delete lens blocks as needed.
- **Parameter Control:** Modify curvature, thickness, and glass materials via a table interface.
- **Ray Tracing Visualization:** Visual representation of light paths based on the current lens data.
- **Optimization:** Includes a basic solver to refine lens parameters.

## 🤝 Contributing
Contributions are welcome! Whether it's adding more glass data, improving the ray tracing engine, or enhancing the UI, please feel free to:
1. Submit a **Pull Request**.
2. Open an **Issue** for bug reports or feature requests.
3. Join the discussion in the **GitHub Discussions** tab.

## 📄 License
This project is licensed under the MIT License.
