package io.quizforge.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Set;

/** Collection behavior is declared by the bank, independently of its question type. */
record BankFeatures(boolean editing, boolean whiteboard, boolean history, boolean exam) {
    BankFeatures(boolean editing, boolean whiteboard, boolean history) { this(editing, whiteboard, history, true); }
    static final BankFeatures DEFAULT = new BankFeatures(true, true, true);
    static BankFeatures read(JsonNode bank) {
        JsonNode value = bank.get("features"); if (value == null) return DEFAULT;
        if (!value.isObject()) throw ApiException.bad("features must be an object of editing, whiteboard, history and exam booleans");
        var names = value.fieldNames(); while (names.hasNext()) { String key = names.next(); if (!Set.of("editing", "whiteboard", "history", "exam").contains(key) || !value.path(key).isBoolean()) throw ApiException.bad("Unknown or non-boolean bank feature: " + key); }
        return new BankFeatures(value.path("editing").asBoolean(true), value.path("whiteboard").asBoolean(true), value.path("history").asBoolean(true), value.path("exam").asBoolean(true));
    }
    ObjectNode json() { return Json.object().put("editing", editing).put("whiteboard", whiteboard).put("history", history).put("exam", exam); }
    void requireEditing() { if (!editing) throw new ApiException(403, "EDITING_DISABLED", "This collection disables editing"); }
    void requireWhiteboard() { if (!whiteboard) throw new ApiException(403, "WHITEBOARD_DISABLED", "This collection disables the whiteboard"); }
    void requireHistory() { if (!history) throw new ApiException(403, "HISTORY_DISABLED", "This collection keeps practice only in the current page session"); }
}
