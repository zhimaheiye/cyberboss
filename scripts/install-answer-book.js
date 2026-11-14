// Explicit local data installation. Never runs during npm install or server startup.
const path = require("path");
const { AnswerBook } = require("../src/desktop/answer-book");
const dir = path.resolve(process.env.CYBERBOSS_DESKTOP_DIR || path.join(__dirname, "../data/desktop"));
new AnswerBook(dir).downloadDefault().then(result => {
  console.log(`通用句库已保存到 ${path.join(dir, "answer-book")}，新增 ${result.added} 句，跳过重复 ${result.skipped} 句。`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
