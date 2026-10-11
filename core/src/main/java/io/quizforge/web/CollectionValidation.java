package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;
import io.quizforge.web.Library.*;

/** One host preparation and rule validation path for full catalogs and scoped loads. */
final class CollectionValidation {
    record Prepared(String id, String title, String description, String kind, Extension extension,
                    List<Question> questions, BankFeatures features, String checkKey) {
        Prepared { questions = List.copyOf(questions); }
    }
    record Check(List<List<OutlineItem>> outlineItems) {
        Check { outlineItems = outlineItems.stream().map(List::copyOf).toList(); }
    }
    record Result(Library.Collection collection, Check successfulCheck) { }
    private final RuleEngine engine;
    CollectionValidation(RuleEngine engine) { this.engine = engine; }
    Prepared prepare(JsonNode raw, String kind, Extension extension, String id, Map<String, Extension> available) {
        if (!raw.isObject() || (kind.equals("bank") || kind.equals("development-bank")) && !id.equals(Json.id(raw, "id"))) throw ApiException.bad("Invalid bank ID");
        ExtensionApi.requireBank(raw);
        BankFeatures features = BankFeatures.read(raw);
        Extension fallback = raw.has("extension") ? Library.resolveExtension(raw.get("extension"), available) : null;
        if (extension != null && fallback != null && (!extension.id().equals(fallback.id()) || !extension.version().equals(fallback.version()))) throw ApiException.bad("Extension mismatch");
        JsonNode questions = raw.get("questions");
        if (questions == null || !questions.isArray() || questions.isEmpty() || questions.size() > 10000) throw ApiException.bad("Invalid questions");
        var list = new ArrayList<Question>(); var ids = new HashSet<String>(); boolean perQuestion = false;
        for (JsonNode question : questions) {
            String qid = Json.id(question, "id");
            if (question.has("features")) throw ApiException.bad("features belong at the bank root");
            if (!ids.add(qid) || !question.has("data")) throw ApiException.bad("Duplicate question or missing data");
            Extension owner = question.has("extension") ? Library.resolveExtension(question.get("extension"), available) : fallback;
            if (owner == null) throw ApiException.bad("Missing question extension");
            if ((kind.equals("extension") || kind.equals("development")) && (extension == null || !owner.id().equals(extension.id()) || !owner.version().equals(extension.version()))) throw ApiException.bad("Example extension mismatch");
            perQuestion |= question.has("extension");
            JsonNode rawData = question.get("data").deepCopy();
            Outline outline = question.has("outline") ? OutlineItems.readConfiguration(question.get("outline"), owner) : null;
            list.add(new Question(qid, Json.text(question, "title", 300), rawData, Json.fingerprint(rawData, owner.fingerprint()), owner,
                    outline == null ? List.of() : outline.items(), outline));
        }
        String checkKey = Json.fingerprint(raw, kind + ":" + Library.ruleIdentity(list));
        Extension collectionExtension = kind.equals("extension") || kind.equals("development") ? extension : perQuestion || fallback == null ? null : fallback;
        return new Prepared(id, Json.text(raw, "title", 300), Library.optional(raw, "description", 4000), kind, collectionExtension, list, features, checkKey);
    }
    Result finish(Prepared prepared, Check cached, boolean validated, RuntimeException validationFailure) {
        List<Question> list = prepared.questions(); Check checked = cached; Check successful = cached;
        boolean development = prepared.kind().startsWith("development");
        List<Question> outlined;
        if (checked != null) {
            outlined = new ArrayList<>();
            for (int i = 0; i < list.size(); i++) {
                Question question = list.get(i);
                outlined.add(new Question(question.id(), question.title(), question.data(), question.fingerprint(), question.extension(), checked.outlineItems().get(i), question.outline()));
            }
        } else {
            boolean valid = true;
            try { if (validationFailure != null) throw validationFailure; if (!validated) RuleBatches.validate(engine, list); }
            catch (ApiException error) { if (!development || !Library.developmentRuleFailure(error)) throw error; valid = false; }
            try { outlined = RuleBatches.outline(engine, list); }
            catch (ApiException error) { if (!development || !Library.developmentRuleFailure(error)) throw error; outlined = list; valid = false; }
            if (valid) successful = new Check(outlined.stream().map(Question::outlineItems).toList());
        }
        return new Result(new Library.Collection(prepared.id(), prepared.title(), prepared.description(), prepared.kind(), prepared.extension(), outlined, prepared.features()), successful);
    }
}
