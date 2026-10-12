(() => {
  // authorized:C:\Users\wangg\OneDrive\Desktop\QuizForge\quizforge_web\core\shared\richtext\1.1.2\src\document.js
  var FONT_FAMILIES = ["Arial", "Verdana", "Georgia", "Times New Roman", "Consolas", "Microsoft YaHei", "SimSun", "sans-serif", "serif", "monospace"];
  var FONT_SIZES = ["10px", "12px", "14px", "15px", "16px", "18px", "20px", "24px", "28px", "32px", "40px", "48px"];
  var LINE_HEIGHTS = ["1", "1.2", "1.5", "1.8", "2", "2.5", "3"];
  var hash = /^[a-f0-9]{64}$/;
  var color = /^#[a-fA-F0-9]{6}$/;
  var blocks = /* @__PURE__ */ new Set(["paragraph", "heading", "blockquote", "bulletList", "orderedList", "codeBlock", "horizontalRule", "image", "table", "blockMath"]);
  var inlines = /* @__PURE__ */ new Set(["text", "hardBreak", "inlineMath"]);
  var marks = /* @__PURE__ */ new Set(["bold", "italic", "strike", "underline", "code", "link", "textStyle", "highlight", "subscript", "superscript"]);
  var object = (value) => value && typeof value === "object" && !Array.isArray(value);
  var keys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
  var bounded = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  function safeLink(value) {
    return typeof value === "string" && value.length <= 2048 && /^(https?:\/\/|mailto:)/i.test(value) && !/[\u0000-\u0020]/.test(value);
  }
  function validateDocument(doc, { requireContent = false } = {}) {
    let count = 0, textSize = 0, images = 0, meaningful = false;
    function layout(attrs, heading = false) {
      return keys(attrs, heading ? ["level", "textAlign", "lineHeight"] : ["textAlign", "lineHeight"]) && (attrs.textAlign === void 0 || ["left", "center", "right", "justify"].includes(attrs.textAlign)) && (attrs.lineHeight === void 0 || LINE_HEIGHTS.includes(attrs.lineHeight));
    }
    function visit(node, depth, parent) {
      if (!object(node) || depth > 32 || ++count > 5e3 || !keys(node, ["type", "attrs", "content", "text", "marks"])) return false;
      const type = node.type, attrs = node.attrs || {};
      if (typeof type !== "string" || !object(attrs)) return false;
      if (parent === "doc" && !blocks.has(type) || parent === "list" && type !== "listItem" || parent === "inline" && !inlines.has(type) || parent === "code" && type !== "text" || parent === "block" && !blocks.has(type) || parent === "table" && type !== "tableRow" || parent === "row" && !["tableCell", "tableHeader"].includes(type)) return false;
      if (type === "text") {
        if (typeof node.text !== "string" || !node.text.length || node.content || Object.keys(attrs).length || (textSize += node.text.length) > 1e5) return false;
        if (node.text.trim()) meaningful = true;
        if (node.marks !== void 0) {
          if (!Array.isArray(node.marks) || node.marks.length > 10) return false;
          const used = /* @__PURE__ */ new Set();
          for (const mark of node.marks) {
            if (!object(mark) || !keys(mark, ["type", "attrs"]) || !marks.has(mark.type) || used.has(mark.type)) return false;
            used.add(mark.type);
            const ma = mark.attrs || {};
            if (!object(ma)) return false;
            if (mark.type === "link") {
              if (!keys(ma, ["href", "title"]) || !safeLink(ma.href) || ma.title !== void 0 && (typeof ma.title !== "string" || ma.title.length > 500)) return false;
            } else if (mark.type === "textStyle") {
              if (!keys(ma, ["color", "fontFamily", "fontSize"]) || !Object.keys(ma).length || ma.color !== void 0 && !color.test(ma.color) || ma.fontFamily !== void 0 && !FONT_FAMILIES.includes(ma.fontFamily) || ma.fontSize !== void 0 && !FONT_SIZES.includes(ma.fontSize)) return false;
            } else if (mark.type === "highlight") {
              if (!keys(ma, ["color"]) || ma.color !== void 0 && !color.test(ma.color)) return false;
            } else if (Object.keys(ma).length) return false;
          }
          if (parent === "code" && node.marks.length) return false;
        }
        return true;
      }
      if (node.text !== void 0 || node.marks !== void 0) return false;
      if (type === "image") {
        if (!keys(attrs, ["assetId", "alt", "title", "width", "align"]) || !hash.test(attrs.assetId) || ++images > 40 || node.content !== void 0) return false;
        if (["alt", "title"].some((key) => attrs[key] !== void 0 && (typeof attrs[key] !== "string" || attrs[key].length > 500)) || attrs.width !== void 0 && !bounded(attrs.width, 24, 2400) || attrs.align !== void 0 && !["left", "center", "right"].includes(attrs.align)) return false;
        meaningful = true;
        return true;
      }
      if (type === "inlineMath" || type === "blockMath") {
        if (!keys(attrs, ["latex"]) || typeof attrs.latex !== "string" || !attrs.latex.trim() || attrs.latex.length > 2e3 || node.content !== void 0) return false;
        meaningful = true;
        return true;
      }
      if (type === "heading") {
        if (!layout(attrs, true) || ![1, 2, 3].includes(attrs.level)) return false;
      } else if (type === "paragraph") {
        if (!layout(attrs)) return false;
      } else if (type === "orderedList") {
        if (!keys(attrs, ["start"]) || attrs.start !== void 0 && !bounded(attrs.start, 1, 9999)) return false;
      } else if (type === "codeBlock") {
        if (!keys(attrs, ["language"]) || attrs.language !== void 0 && attrs.language !== null && (typeof attrs.language !== "string" || attrs.language.length > 40)) return false;
      } else if (type === "tableCell" || type === "tableHeader") {
        if (!keys(attrs, ["colspan", "rowspan", "colwidth"]) || attrs.colspan !== void 0 && !bounded(attrs.colspan, 1, 30) || attrs.rowspan !== void 0 && !bounded(attrs.rowspan, 1, 30) || attrs.colwidth !== void 0 && attrs.colwidth !== null && (!Array.isArray(attrs.colwidth) || attrs.colwidth.length !== (attrs.colspan || 1) || attrs.colwidth.some((width) => !bounded(width, 24, 2400)))) return false;
      } else if (Object.keys(attrs).length) return false;
      if (type === "hardBreak" || type === "horizontalRule") return node.content === void 0;
      const content = node.content || [];
      if (!Array.isArray(content)) return false;
      if (type === "doc") {
        if (depth !== 0 || !content.length) return false;
        return content.every((child) => visit(child, depth + 1, "doc"));
      }
      if (type === "paragraph" || type === "heading") return content.every((child) => visit(child, depth + 1, "inline"));
      if (type === "codeBlock") return content.every((child) => visit(child, depth + 1, "code"));
      if (type === "bulletList" || type === "orderedList") return !!content.length && content.every((child) => visit(child, depth + 1, "list"));
      if (type === "blockquote" || type === "tableCell" || type === "tableHeader") return !!content.length && content.every((child) => visit(child, depth + 1, "block"));
      if (type === "listItem") return !!content.length && content[0].type === "paragraph" && content.every((child) => visit(child, depth + 1, "block"));
      if (type === "table") return content.length > 0 && content.length <= 30 && content.every((child) => visit(child, depth + 1, "table"));
      if (type === "tableRow") return content.length > 0 && content.reduce((sum, cell) => sum + (cell.attrs?.colspan || 1), 0) <= 30 && content.every((child) => visit(child, depth + 1, "row"));
      return false;
    }
    try {
      return object(doc) && doc.type === "doc" && visit(doc, 0, null) && (!requireContent || meaningful);
    } catch {
      return false;
    }
  }

  // authorized:C:\Users\wangg\OneDrive\Desktop\QuizForge\quizforge_web\extensions\考研英语\reading-gap-2026-dev\rules-source.js
  var object2 = (v) => v && typeof v === "object" && !Array.isArray(v);
  var half = (v) => Number.isFinite(v) && Number.isInteger(v * 2);
  var submitted = (s) => s?.submitted || s?.status === "submitted";
  var uniform = (d) => (typeof d.explanation === "string" || validateDocument(d.explanation)) && half(d.pointsPerItem) && d.pointsPerItem > 0 && d.maxScore === d.pointsPerItem * d.parts.length && d.maxScore <= 1e5 && new Set(d.parts.map((p) => p.id)).size === d.parts.length && validateDocument(d.stem, { requireContent: true });
  var validResponses = (a, d, check) => object2(a?.responses) && Object.entries(a.responses).every(([id, v]) => {
    const p = d.parts.find((p2) => p2.id === id);
    return p && typeof v === "string" && check(v, p);
  });
  var hasAnswer = (a) => Object.values(a.responses).some((v) => v.trim());
  QF.defineType({
    project(data, state) {
      return { stem: data.stem, paragraphIds: data.paragraphIds, pointsPerItem: data.pointsPerItem, maxScore: data.maxScore, parts: data.parts, slots: data.slots.map((s) => ({ id: s.id, locked: s.locked, ...s.locked || state?.submitted ? { correctParagraphId: s.correctParagraphId } : {} })), ...state?.submitted ? { explanation: data.explanation } : {} };
    },
    validateQuestion(d) {
      return uniform(d) && d.slots.length === 5 && [6, 7].includes(d.paragraphIds.length) && d.parts.length === 5 && d.slots.every((s) => !s.locked) && new Set(d.slots.map((s) => s.id)).size === d.slots.length && new Set(d.slots.map((s) => s.correctParagraphId)).size === d.slots.length && d.slots.every((s) => d.paragraphIds.includes(s.correctParagraphId)) && new Set(d.parts.map((p) => p.slotId)).size === 5 && d.parts.every((p) => d.slots.some((s) => s.id === p.slotId && !s.locked));
    },
    validateAnswer(a, d) {
      const values = Object.values(a?.responses || {}).filter(Boolean);
      return validResponses(a, d, (v) => v === "" || d.paragraphIds.includes(v) && !d.slots.some((s) => s.locked && s.correctParagraphId === v)) && new Set(values).size === values.length;
    },
    grade(d, a) {
      if (!hasAnswer(a)) throw new Error("\u8BF7\u5148\u4F5C\u7B54\u3002");
      const score = d.parts.reduce((n, p) => n + (a.responses[p.id] === d.slots.find((s) => s.id === p.slotId).correctParagraphId ? d.pointsPerItem : 0), 0);
      return { gradingStatus: "graded", score, maxScore: d.maxScore, correct: score === d.maxScore, feedback: null };
    },
    getScore(d, s) {
      const value = { score: submitted(s) ? s.result?.score ?? null : 0, maxScore: d.maxScore };
      if (submitted(s) && s.answer?.responses) value.outlineStates = d.parts.map((p) => ({ id: p.id, status: !s.answer.responses[p.id]?.trim() ? "unanswered" : s.answer.responses[p.id] === d.slots.find((x) => x.id === p.slotId).correctParagraphId ? "correct" : "incorrect" }));
      return value;
    }
  });
})();
