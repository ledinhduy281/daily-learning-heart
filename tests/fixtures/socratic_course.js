const fs = require("node:fs");
const vm = require("node:vm");

const browser = {window: {}};
vm.runInNewContext(fs.readFileSync(require.resolve("../../data/briefings.js"), "utf8"), browser);
const lesson = browser.window.EBM_BRIEFINGS_DATA.focused_lessons["2"];
const pmid = lesson.primary_source.pmid;
const excerpts = lesson.quiz_source_texts[pmid];
const quote = excerpts.find(t => t.includes("hazard ratio"));
const skills = [
  {vi: "Đọc kết cục tim mạch", en: "Interpret cardiovascular outcomes"},
  {vi: "Phân biệt các tiêu chí đánh giá", en: "Distinguish trial endpoints"},
  {vi: "Áp dụng kết quả theo quần thể", en: "Apply results to the trial population"},
  {vi: "Nhận diện giới hạn suy luận", en: "Identify limits of inference"},
];
const formats = ["explain", "predict", "apply", "critique", "connect"];
const options = [
  {vi: "Giảm biến cố tim mạch chính", en: "Fewer primary cardiovascular events"},
  {vi: "Không khác biệt về biến cố tim mạch chính", en: "No difference in primary cardiovascular events"},
  {vi: "Tăng biến cố tim mạch chính", en: "More primary cardiovascular events"},
  {vi: "Không đánh giá biến cố tim mạch chính", en: "Primary cardiovascular events were not assessed"},
];

function course(round = 1) {
  const items = [];
  const add = (phase, skill, tier, format) => {
    const label = `${String(round).replace(/\d/g, n => String.fromCharCode(97 + Number(n)))}-${String.fromCharCode(97 + items.length)}`;
    const isCase = format === "apply" || format === "predict";
    const vignette = isCase ? {
      vi: "Một phụ nữ cao tuổi chưa mắc bệnh tim mạch hỏi về kết quả dùng atorvastatin. ",
      en: "An older woman without cardiovascular disease asks what the trial found about atorvastatin. ",
    } : {vi: "", en: ""};
    items.push({phase, skill, tier, format, type: isCase ? "case" : "theory",
      pmid, excerpt: excerpts.indexOf(quote) + 1, quote, options, answer: "A",
      stem_vi: `${vignette.vi}STAREE ghi nhận thay đổi nào về kết cục tim mạch chính? (${label})`,
      stem_en: `${vignette.en}What did STAREE find about primary cardiovascular outcomes? (${label})`,
      explanation_vi: "Tỉ số nguy cơ được báo cáo thấp hơn một, theo hướng giảm biến cố.",
      explanation_en: "The reported hazard ratio was below one, in the direction of fewer events.",
      ...(phase === "practice" ? {
        hint_vi: "Tỉ số nguy cơ nằm về phía nào của giá trị không hiệu ứng?",
        hint_en: "Where does the hazard ratio sit relative to the no-effect value?",
      } : {}),
    });
  };
  skills.forEach((_, i) => add("diagnostic", i, ["easy", "medium", "medium", "hard"][i], formats[i]));
  skills.forEach((_, i) => ["medium", "hard", "hard"].forEach((tier, j) =>
    add("practice", i, tier, i === 3 && j === 2 ? "apply" : formats[(i + j) % formats.length])));
  skills.forEach((_, i) => add("final", i, "hard", i === 0 ? "apply" : formats[i]));
  add("final", null, "hard", "connect");
  return {version: 2, set_id: `fixture-${round}`, skills, items};
}

module.exports = {course, lesson};
