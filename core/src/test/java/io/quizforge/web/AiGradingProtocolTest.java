package io.quizforge.web;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class AiGradingProtocolTest {
    private ObjectNode input() {
        ObjectNode input = Json.object().put("protocolVersion", 1).put("maxScore", 5).put("scoreStep", 0.5);
        for (String field : new String[]{"question", "answer", "referenceAnswer"})
            input.putArray(field).add(Json.object().put("type", "text").put("text", field + " content"));
        return input;
    }
    private void validate(ObjectNode input) {
        AiGradingProtocol.validateInput(input);
    }
    @Test void combinedReferenceIsValidAndUnknownFieldsAndEmptyReferenceAreRejected() {
        ObjectNode input = input(); validate(input);
        assertEquals(6, input.size()); assertEquals(input, AiGradingProtocol.normalizeInput(input));
        ObjectNode empty = input.deepCopy(); empty.putArray("referenceAnswer");
        assertEquals("INVALID_AI_INPUT", assertThrows(ApiException.class, () -> validate(empty)).code);
        ObjectNode unknown = input.deepCopy().put("prompt", "override");
        assertEquals("INVALID_AI_INPUT", assertThrows(ApiException.class, () -> validate(unknown)).code);
    }
    @Test void legacyReferenceAndRubricKeepOrderImagesAndOriginalBytes() {
        ObjectNode input = input(); input.putArray("rubric")
                .add(Json.object().put("type", "text").put("text", "criterion"))
                .add(Json.object().put("type", "image").put("assetId", "a".repeat(64)));
        String before = input.toString(); validate(input);
        ObjectNode combined = AiGradingProtocol.normalizeInput(input);
        assertFalse(combined.has("rubric")); assertEquals(6, combined.size());
        assertEquals("referenceAnswer content", combined.at("/referenceAnswer/1/text").asText());
        assertEquals("criterion", combined.at("/referenceAnswer/3/text").asText());
        assertEquals("a".repeat(64), combined.at("/referenceAnswer/4/assetId").asText());
        assertEquals(before, input.toString());
        assertEquals(combined, AiGradingProtocol.normalizeInput(combined));
    }
    @Test void legacyEmptyReferenceStillUsesItsRubricAndInvalidRubricCannotBeDropped() {
        ObjectNode input = input(); input.putArray("referenceAnswer");
        input.putArray("rubric").add(Json.object().put("type", "text").put("text", "criterion only"));
        validate(input);
        assertEquals("criterion only", AiGradingProtocol.normalizeInput(input).at("/referenceAnswer/1/text").asText());
        for (ObjectNode bad : new ObjectNode[]{input.deepCopy().putNull("rubric"), input.deepCopy().put("rubric", "invalid")})
            assertThrows(ApiException.class, () -> validate(bad));
        ObjectNode empty = input.deepCopy(); empty.putArray("rubric");
        assertThrows(ApiException.class, () -> validate(empty));
    }
    @Test void scoreParametersAreIndependentAndNeedNotDivideEvenly() {
        validate(input().put("maxScore", 2.5).put("scoreStep", 0.3));
        validate(input().put("maxScore", 6).put("scoreStep", 10));
    }
    @Test void scoreParametersStillRequireUsableNumericTypes() {
        for (ObjectNode invalid : new ObjectNode[]{input().put("maxScore", "5"), input().put("maxScore", 0),
                input().put("maxScore", Double.POSITIVE_INFINITY), input().put("scoreStep", "0.5"),
                input().put("scoreStep", 0), input().put("scoreStep", Double.NaN)})
            assertEquals("INVALID_AI_INPUT", assertThrows(ApiException.class, () -> validate(invalid)).code);
    }
}
