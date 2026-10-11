package io.quizforge.web;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Validate catalog questions together while keeping failures attached to their original collection. */
final class CatalogRuleValidation {
    private record Identity(String id, String version, String fingerprint, String directory, boolean development) {
        String order() { return id + "@" + version + ":" + fingerprint + ":" + directory + ":" + development; }
    }
    private static final class Group {
        final Map<Integer, List<Library.Question>> collections = new LinkedHashMap<>();
    }
    private CatalogRuleValidation() { }

    /** Null inputs have already passed a cached check or need ordered, individual validation. */
    static Map<Integer, RuntimeException> validate(RuleEngine rules, List<List<Library.Question>> collections) {
        Map<Identity, Group> groups = new LinkedHashMap<>();
        for (int index = 0; index < collections.size(); index++) {
            List<Library.Question> questions = collections.get(index); if (questions == null) continue;
            for (Library.Question question : questions) {
                Library.Extension extension = question.extension();
                Identity identity = new Identity(extension.id(), extension.version(), extension.fingerprint(), extension.directory().toString(), DevelopmentExtensions.runtimeMetadata(extension) != null);
                Group group = groups.computeIfAbsent(identity, unused -> new Group());
                group.collections.computeIfAbsent(index, unused -> new ArrayList<>()).add(question);
            }
        }
        Map<Integer, RuntimeException> failures = new LinkedHashMap<>();
        var ordered = new ArrayList<>(groups.entrySet()); ordered.sort(Comparator.comparing(entry -> entry.getKey().order()));
        for (var entry : ordered) {
            Group group = entry.getValue();
            var collectionsToValidate = new ArrayList<List<Library.Question>>();
            for (var collection : group.collections.entrySet()) if (!failures.containsKey(collection.getKey())) collectionsToValidate.add(collection.getValue());
            if (collectionsToValidate.isEmpty()) continue;
            try {
                // Retain both the existing size bounds and original VM reset boundaries.
                RuleBatches.validateCollections(rules, collectionsToValidate);
            } catch (RuntimeException mergedFailure) {
                // A rejected question or deadline must not mark neighboring banks invalid.
                // Retry each original collection's portion and preserve the first failing type.
                for (var collection : group.collections.entrySet()) {
                    if (failures.containsKey(collection.getKey())) continue;
                    try { RuleBatches.validate(rules, collection.getValue()); }
                    catch (RuntimeException individualFailure) { failures.put(collection.getKey(), individualFailure); }
                }
            }
        }
        return failures;
    }
}
