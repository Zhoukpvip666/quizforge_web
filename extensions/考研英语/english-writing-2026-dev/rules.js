(() => {
  // quizforge_web/core/shared/richtext/1.1.2/src/document.js
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

  // quizforge_web/extensions/考研英语/english-writing-2026-dev/ai-document.js
  function toAiBlocks(doc) {
    if (!validateDocument(doc, { requireContent: true })) throw new Error("\u8BC4\u5206\u5185\u5BB9\u4E0D\u662F\u6709\u6548\u7684\u5BCC\u6587\u672C\u6587\u6863\u3002");
    const blocks2 = [];
    const addText = (text) => {
      if (!text.trim()) return;
      const previous = blocks2.at(-1);
      if (previous?.type === "text") previous.text += "\n\n" + text;
      else blocks2.push({ type: "text", text });
    };
    const inline = (node) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type === "inlineMath") return `$${node.attrs.latex}$`;
      if (node.type !== "text") return (node.content || []).map(inline).join("");
      const link = node.marks?.find((mark) => mark.type === "link");
      return link ? `${node.text} (${link.attrs.href})` : node.text;
    };
    function walk(node, prefix = "", depth = 0) {
      if (node.type === "image") {
        blocks2.push({ type: "image", assetId: node.attrs.assetId, alt: node.attrs.alt || node.attrs.title || "" });
        return;
      }
      if (node.type === "blockMath") {
        addText(`${prefix}$$
${node.attrs.latex}
$$`);
        return;
      }
      if (node.type === "paragraph" || node.type === "heading") {
        const text = (node.content || []).map(inline).join("");
        addText(prefix + (node.type === "heading" ? "#".repeat(node.attrs.level) + " " : "") + text);
        return;
      }
      if (node.type === "codeBlock") {
        addText(`${prefix}\`\`\`${node.attrs?.language || ""}
${(node.content || []).map(inline).join("")}
\`\`\``);
        return;
      }
      if (node.type === "horizontalRule") {
        addText(prefix + "---");
        return;
      }
      if (node.type === "blockquote") {
        for (const child of node.content || []) walk(child, prefix + "> ", depth);
        return;
      }
      if (node.type === "table") {
        addText(prefix + "\u8868\u683C\u5F00\u59CB");
        const occupied = /* @__PURE__ */ new Map();
        for (let row = 0; row < (node.content || []).length; row++) {
          let col = 0;
          for (const cell of node.content[row].content || []) {
            while ((occupied.get(col) || 0) > row) col++;
            const span = [], colspan = cell.attrs?.colspan || 1, rowspan = cell.attrs?.rowspan || 1;
            if (colspan > 1) span.push(`\u8DE8 ${colspan} \u5217`);
            if (rowspan > 1) span.push(`\u8DE8 ${rowspan} \u884C`);
            addText(`${prefix}\u7B2C ${row + 1} \u884C\uFF0C\u7B2C ${col + 1} \u5217${cell.type === "tableHeader" ? "\uFF08\u8868\u5934\uFF09" : ""}${span.length ? "\uFF08" + span.join("\uFF0C") + "\uFF09" : ""}\uFF1A`);
            for (const child of cell.content || []) walk(child, prefix, depth);
            for (let offset = 0; offset < colspan; offset++) occupied.set(col + offset, row + rowspan);
            col += colspan;
          }
        }
        addText(prefix + "\u8868\u683C\u7ED3\u675F");
        return;
      }
      if (node.type === "bulletList" || node.type === "orderedList") {
        let index = node.attrs?.start || 1;
        for (const item of node.content || []) {
          const marker = node.type === "orderedList" ? `${index++}. ` : "\u2022 ";
          for (let i = 0; i < (item.content || []).length; i++) {
            const child = item.content[i];
            walk(child, prefix + "  ".repeat(depth) + (i === 0 ? marker : "  "), depth + 1);
          }
        }
        return;
      }
      for (const child of node.content || []) walk(child, prefix, depth);
    }
    walk(doc);
    if (!blocks2.length) throw new Error("\u8BC4\u5206\u5185\u5BB9\u4E3A\u7A7A\u3002");
    return blocks2;
  }
  function prepareAiGrading(data, answer) {
    const reference = validateDocument(data.referenceAnswer, { requireContent: true }) ? toAiBlocks(data.referenceAnswer) : [{ type: "text", text: "\u672A\u63D0\u4F9B\u53C2\u8003\u8303\u6587\u3002\u8BF7\u4F9D\u636E\u9898\u5E72\u4EFB\u52A1\u8BC4\u4EF7\u4F5C\u7B54\uFF0C\u4E0D\u865A\u6784\u5B98\u65B9\u8303\u6587\u3002" }];
    const rubric = validateDocument(data.rubric, { requireContent: true }) ? toAiBlocks(data.rubric) : [{ type: "text", text: (validateDocument(data.referenceAnswer, { requireContent: true }) ? "\u8303\u6587\u4E0E\u8BC4\u5206\u7EC6\u5219\u5408\u5E76\u5728\u53C2\u8003\u5185\u5BB9\u4E2D\u3002\u4F18\u5148\u9075\u5FAA\u5176\u4E2D\u660E\u786E\u7ED9\u51FA\u7684\u8BC4\u5206\u4F9D\u636E\uFF1B\u672A\u660E\u786E\u7ED9\u51FA\u65F6\uFF0C" : "\u672A\u63D0\u4F9B\u4E13\u95E8\u8BC4\u5206\u7EC6\u5219\u3002") + "\u4F9D\u636E\u9898\u5E72\u7684\u5185\u5BB9\u4EFB\u52A1\u3001\u4F53\u88C1\u3001\u5B57\u6570\u8981\u6C42\uFF0C\u4EE5\u53CA\u8BED\u8A00\u51C6\u786E\u6027\u3001\u8FDE\u8D2F\u6027\u8BC4\u4EF7\u82F1\u8BED\u4F5C\u6587\u3002\u6309\u672C\u9898\u6EE1\u5206\u548C0.5\u5206\u6B65\u957F\u8BC4\u5206\uFF0C\u53CD\u9988\u5177\u4F53\u4F18\u70B9\u4E0E\u95EE\u9898\u3002\u4E0D\u5F97\u58F0\u79F0\u8FD9\u662F\u5B98\u65B9\u8BC4\u5206\u6807\u51C6\u3002" }];
    return { protocolVersion: 1, question: toAiBlocks(data.stem), answer: toAiBlocks(answer.document), referenceAnswer: [{ type: "text", text: "\u53C2\u8003\u8303\u6587\uFF1A" }, ...reference, { type: "text", text: "\u8BC4\u5206\u4F9D\u636E\uFF1A" }, ...rubric], maxScore: data.maxScore, scoreStep: 0.5 };
  }

  // quizforge_web/extensions/考研英语/english-writing-2026-dev/rules-source.js
  var object2 = (v) => v && typeof v === "object" && !Array.isArray(v);
  var half = (v) => Number.isFinite(v) && Number.isInteger(v * 2);
  var submitted = (s) => s?.submitted || s?.status === "submitted";
  QF.defineType({
    prepareAiGrading,
    validateQuestion(d) {
      return validateDocument(d.stem, { requireContent: true }) && half(d.maxScore) && d.maxScore > 0 && d.maxScore <= 1e5 && ["referenceAnswer", "rubric"].every((k) => d[k] === null || validateDocument(d[k]));
    },
    validateAnswer(a) {
      return a?.formatVersion === 1 && validateDocument(a.document);
    },
    project(d, s) {
      return { formatVersion: 1, stem: d.stem, wordCount: d.wordCount, maxScore: d.maxScore, ...submitted(s) ? { referenceAnswer: d.referenceAnswer, rubric: d.rubric } : {} };
    },
    grade(d, a) {
      if (!validateDocument(a.document, { requireContent: true })) throw new Error("\u8BF7\u5148\u586B\u5199\u4F5C\u6587\u3002");
      return { gradingStatus: "pending", score: null, maxScore: d.maxScore, correct: null, feedback: null };
    },
    review(d, a, r) {
      if (!object2(r) || !half(r.score) || r.score < 0 || r.score > d.maxScore || Object.keys(r).some((k) => !["score", "feedback"].includes(k)) || r.feedback !== void 0 && (typeof r.feedback !== "string" || r.feedback.length > 2e4)) throw new Error("\u8BC4\u5206\u987B\u57280\u81F3\u6EE1\u5206\u4E4B\u95F4\uFF0C\u4EE50.5\u4E3A\u6B65\u957F\u3002");
      return { gradingStatus: "graded", score: r.score, maxScore: d.maxScore, correct: r.score === d.maxScore, feedback: r.feedback ?? null };
    },
    getScore(d, s) {
      return { score: submitted(s) ? s.result.score : 0, maxScore: d.maxScore };
    }
  });
})();
