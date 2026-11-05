// После `tauri android init`: убираем LAUNCHER у MainActivity — на рабочем столе
// приложение показывают ярлыки-иконки из плагина (выбор иконки в настройках).
import { readFileSync, writeFileSync } from "node:fs";

const path = "src-tauri/gen/android/app/src/main/AndroidManifest.xml";
const xml = readFileSync(path, "utf8");
const start = xml.indexOf('android:name=".MainActivity"');
if (start < 0) throw new Error("MainActivity не найден в манифесте");
const end = xml.indexOf("</activity>", start);
const block = xml.slice(start, end);
const fixed = block.replace(/\s*<category android:name="android.intent.category.LAUNCHER" \/>/, "");
if (fixed === block && !block.includes("LAUNCHER")) console.log("LAUNCHER уже убран");
writeFileSync(path, xml.slice(0, start) + fixed + xml.slice(end));
console.log("MainActivity без LAUNCHER — иконки из плагина");
