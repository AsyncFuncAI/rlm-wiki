import { describe, expect, test } from "bun:test";
import { documentationPresentationQualityIssue } from "./docs-presentation-quality.ts";

const intro =
  "The runtime owns one provider-neutral generation path and persists accepted pages only after validation.";
const bridge =
  "This choice changes how the next operation is read, so the primary behavior stays visible before the alternative surface appears.";

function sectionWith(...lines: string[]): string {
  return [intro, "", "## Configure", "", bridge, "", ...lines].join("\n");
}

describe("documentation presentation quality", () => {
  test("accepts plain MDX and paced components in separate sections", () => {
    expect(
      documentationPresentationQualityIssue(
        [
          intro,
          "",
          "## Choose a path",
          "",
          bridge,
          "",
          "<CardGroup>",
          '<Card title="Quickstart" href="/quickstart">Start here.</Card>',
          "</CardGroup>",
          "",
          "## Run the first task",
          "",
          bridge,
          "",
          "<Steps>",
          '<Step title="Install">Run the install command.</Step>',
          "</Steps>",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  test("rejects a CardGroup before the first section", () => {
    expect(
      documentationPresentationQualityIssue(
        [
          intro,
          "",
          "<CardGroup>",
          '<Card title="Quickstart" href="/quickstart">Start here.</Card>',
          "</CardGroup>",
          "",
          "## Details",
          "",
          bridge,
        ].join("\n"),
      ),
    ).toContain("before the first section");
  });

  test("rejects the cards directive before the first section", () => {
    expect(
      documentationPresentationQualityIssue(
        [
          intro,
          "",
          ":::cards",
          "- [Quickstart](/quickstart) Start here.",
          ":::",
          "",
          "## Details",
          "",
          bridge,
        ].join("\n"),
      ),
    ).toContain("before the first section");
  });

  test("rejects different back-to-back rich component families", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          "<CardGroup>",
          '<Card title="Local" href="/local">Local path.</Card>',
          "</CardGroup>",
          "",
          "<Steps>",
          '<Step title="Run">Run it.</Step>',
          "</Steps>",
        ),
      ),
    ).toContain("without explanatory prose");
  });

  test("accepts a hard-wrapped ordinary prose bridge", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          "<CardGroup>",
          '<Card title="Local" href="/local">Local path.</Card>',
          "</CardGroup>",
          "",
          "The selected runtime keeps",
          "the primary operation visible before alternatives appear.",
          "",
          "<Steps>",
          '<Step title="Run">Run it.</Step>',
          "</Steps>",
        ),
      ),
    ).toBeNull();
  });

  test("counts bridge length in Unicode code points", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          "<CardGroup>",
          '<Card title="Local" href="/local">Local path.</Card>',
          "</CardGroup>",
          "",
          "😀".repeat(12),
          "",
          "<Steps>",
          '<Step title="Run">Run it.</Step>',
          "</Steps>",
        ),
      ),
    ).toContain("without explanatory prose");
  });

  test("rejects more than two rich component families in one section", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          "<CardGroup>",
          '<Card title="Local" href="/local">Local path.</Card>',
          "</CardGroup>",
          "",
          bridge,
          "",
          "<Steps>",
          '<Step title="Run">Run it.</Step>',
          "</Steps>",
          "",
          bridge,
          "",
          "<Tabs>",
          '<Tab title="macOS">Use the macOS command.</Tab>',
          "</Tabs>",
        ),
      ),
    ).toContain("more than two rich component families");
  });

  test("allows explicit consecutive endpoint siblings", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          ":::endpoint GET /api/runs Load runs",
          "The route returns persisted runs.",
          ":::",
          ":::endpoint POST /api/runs Create a run",
          "The route persists an accepted request.",
          ":::",
        ),
      ),
    ).toBeNull();
  });

  test("allows implicit consecutive endpoint siblings", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          ":::endpoint GET /api/runs Load runs",
          "The route returns persisted runs.",
          ":::endpoint POST /api/runs Create a run",
          "The route persists an accepted request.",
          ":::",
        ),
      ),
    ).toBeNull();
  });

  test("ignores component-looking text inside a generic code fence", () => {
    expect(
      documentationPresentationQualityIssue(
        [
          intro,
          "",
          "```mdx",
          "<CardGroup>",
          ":::steps",
          "## Not a section",
          "</CardGroup>",
          "```",
          "",
          "## Details",
          "",
          bridge,
        ].join("\n"),
      ),
    ).toBeNull();
  });

  test("does not use fenced text as an explanatory bridge", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          "<CardGroup>",
          '<Card title="Local" href="/local">Local path.</Card>',
          "</CardGroup>",
          "",
          "```text",
          bridge,
          "```",
          "",
          "<Steps>",
          '<Step title="Run">Run it.</Step>',
          "</Steps>",
        ),
      ),
    ).toContain("without explanatory prose");
  });

  test("does not use an indented list continuation as an explanatory bridge", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          "<CardGroup>",
          '<Card title="Local" href="/local">Local path.</Card>',
          "</CardGroup>",
          "",
          "- Runtime option:",
          "  This long continuation belongs to the list item and cannot pace a following component.",
          "<Steps>",
          '<Step title="Run">Run it.</Step>',
          "</Steps>",
        ),
      ),
    ).toContain("without explanatory prose");
  });

  test("keeps an indented renderer-supported MDX block outside list ownership", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          "<CardGroup>",
          '<Card title="Local" href="/local">Local path.</Card>',
          "</CardGroup>",
          "- Runtime option:",
          "  <Steps>",
          '    <Step title="Run">Run it.</Step>',
          "  </Steps>",
        ),
      ),
    ).toContain("without explanatory prose");
  });

  test("keeps an indented renderer-supported directive outside list ownership", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          "<CardGroup>",
          '<Card title="Local" href="/local">Local path.</Card>',
          "</CardGroup>",
          "- Runtime option:",
          "  :::steps",
          "  - Run the provider-neutral runtime.",
          "  :::",
        ),
      ),
    ).toContain("without explanatory prose");
  });

  test("does not truncate an MDX component at a closing tag inside a code fence", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          "<CardGroup>",
          "```text",
          "</CardGroup>",
          "```",
          bridge,
          "</CardGroup>",
          "",
          "<Steps>",
          '<Step title="Run">Run it.</Step>',
          "</Steps>",
        ),
      ),
    ).toContain("without explanatory prose");
  });

  test("masks headings inside callouts instead of creating a real section", () => {
    expect(
      documentationPresentationQualityIssue(
        [
          intro,
          "",
          "<Note>",
          "## This heading belongs to the note",
          bridge,
          "</Note>",
          "",
          "<CardGroup>",
          '<Card title="Local" href="/local">Local path.</Card>',
          "</CardGroup>",
          "",
          "## Real section",
          "",
          bridge,
        ].join("\n"),
      ),
    ).toContain("before the first section");
  });

  test("masks field and details bodies, while raw details count as accordion", () => {
    const fieldIssue = documentationPresentationQualityIssue(
      [
        intro,
        "",
        '<ParamField body="runtime" type="string">',
        "## This heading belongs to the field",
        bridge,
        "</ParamField>",
        "",
        "<CardGroup>",
        '<Card title="Local" href="/local">Local path.</Card>',
        "</CardGroup>",
        "",
        "## Real section",
        "",
        bridge,
      ].join("\n"),
    );
    const detailsIssue = documentationPresentationQualityIssue(
      [
        intro,
        "",
        "<details>",
        "<summary>Optional behavior</summary>",
        "## This heading belongs to details",
        bridge,
        "</details>",
        "",
        "## Real section",
        "",
        bridge,
      ].join("\n"),
    );

    expect(fieldIssue).toContain("before the first section");
    expect(detailsIssue).toContain("before the first section");
  });

  test("masks a fenced raw-details close until the owning details block ends", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          "<details>",
          "<summary>Optional behavior</summary>",
          "```text",
          "</details>",
          "```",
          bridge,
          "</details>",
          "",
          "<Steps>",
          '<Step title="Run">Run it.</Step>',
          "</Steps>",
        ),
      ),
    ).toContain("without explanatory prose");
  });

  test("masks nested raw details until the outer details block ends", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          "<details>",
          "<summary>Outer behavior</summary>",
          "<details><summary>Nested behavior</summary>Nested detail.</details>",
          bridge,
          "</details>",
          "",
          "<Steps>",
          '<Step title="Run">Run it.</Step>',
          "</Steps>",
        ),
      ),
    ).toContain("without explanatory prose");
  });

  test("recognizes Mermaid aliases, implicit fences, and indented diagrams", () => {
    const diagrams = [
      ["```mermaid", "flowchart TD", "  A --> B", "```"],
      ["```mmd", "sequenceDiagram", "  A->>B: Run", "```"],
      ['```flowchart title="Runtime path"', "  A --> B", "```"],
      ["```", "stateDiagram-v2", "  [*] --> Ready", "```"],
      ["```text", "classDiagram", "  Runtime --> Store", "```"],
      ["```plain", "erDiagram", "  RUN ||--o{ PAGE : contains", "```"],
      ["    journey", "      title Runtime path"],
    ];

    for (const diagram of diagrams) {
      expect(
        documentationPresentationQualityIssue(
          [intro, "", ...diagram, "", "## Details", "", bridge].join("\n"),
        ),
      ).toContain("before the first section");
    }
  });

  test("recognizes fenced and indented ASCII diagrams before the first section", () => {
    const asciiDiagram = [
      "+---------+",
      "| Runtime |",
      "+----+----+",
      "     |",
      "     v",
      "+----+----+",
      "| Store   |",
      "+---------+",
    ];
    const diagrams = [
      ["```ascii", ...asciiDiagram, "```"],
      asciiDiagram.map((line) => `    ${line}`),
    ];

    for (const diagram of diagrams) {
      expect(
        documentationPresentationQualityIssue(
          [intro, "", ...diagram, "", "## Details", "", bridge].join("\n"),
        ),
      ).toContain("before the first section");
    }
  });

  test("keeps ordinary plain output as code instead of an ASCII diagram", () => {
    expect(
      documentationPresentationQualityIssue(
        [
          intro,
          "",
          "```text",
          "status: ready",
          "owner: runtime",
          "store: local",
          "```",
          "",
          "## Details",
          "",
          bridge,
        ].join("\n"),
      ),
    ).toBeNull();
  });

  test("keeps Mermaid-looking Rust fences as ordinary code", () => {
    expect(
      documentationPresentationQualityIssue(
        [
          intro,
          "",
          "```rust",
          "flowchart TD",
          "A --> B",
          "```",
          "",
          "## Details",
          "",
          bridge,
        ].join("\n"),
      ),
    ).toBeNull();
  });

  test("treats top-level RequestExample and ResponseExample as repeated examples", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          '<RequestExample title="Create a run">',
          "```json",
          '{"prompt":"Explain the runtime"}',
          "```",
          "</RequestExample>",
          "",
          '<ResponseExample title="Accepted run">',
          "```json",
          '{"id":"run-1"}',
          "```",
          "</ResponseExample>",
        ),
      ),
    ).toBeNull();
  });

  test("collects inline, nested, and mid-line MDX closing tags", () => {
    const inline = [
      intro,
      "<CardGroup><Card title=\"Local\">Run locally.</Card></CardGroup>",
      "## Details",
      bridge,
    ].join("\n");
    const nestedThenDifferent = sectionWith(
      "<CardGroup>",
      "<CardGroup>",
      '<Card title="Nested">Nested choice.</Card>',
      "</CardGroup>",
      bridge,
      "</CardGroup>",
      "",
      "<Steps>",
      '<Step title="Run">Run it.</Step>',
      "</Steps>",
    );
    const midLineThenDifferent = sectionWith(
      "<CardGroup>",
      '<Card title="Local">Run locally.</Card> </CardGroup> trailing text is renderer-owned.',
      "",
      "<Steps>",
      '<Step title="Run">Run it.</Step>',
      "</Steps>",
    );

    expect(documentationPresentationQualityIssue(inline)).toContain("before the first section");
    expect(documentationPresentationQualityIssue(nestedThenDifferent)).toContain(
      "without explanatory prose",
    );
    expect(documentationPresentationQualityIssue(midLineThenDifferent)).toContain(
      "without explanatory prose",
    );
  });

  test("masks an inline nested same-tag component until the outer close", () => {
    expect(
      documentationPresentationQualityIssue(
        sectionWith(
          "<CardGroup>",
          '<CardGroup><Card title="Nested">Nested choice.</Card></CardGroup>',
          bridge,
          "</CardGroup>",
          "",
          "<Steps>",
          '<Step title="Run">Run it.</Step>',
          "</Steps>",
        ),
      ),
    ).toContain("without explanatory prose");
  });

  test("masks nested endpoint metadata and counts request/response directives as examples", () => {
    const nestedEndpoint = sectionWith(
      ":::endpoint POST /api/runs Create a run",
      ":::params",
      "- `prompt` | `string` | required | Input prompt.",
      ":::",
      ":::request Input",
      "```json",
      '{"prompt":"Explain the runtime"}',
      "```",
      ":::",
      ":::",
    );
    const repeatedExamples = sectionWith(
      ":::request Input",
      '{"prompt":"Explain the runtime"}',
      ":::",
      ":::response Output",
      '{"id":"run-1"}',
      ":::",
    );

    expect(documentationPresentationQualityIssue(nestedEndpoint)).toBeNull();
    expect(documentationPresentationQualityIssue(repeatedExamples)).toBeNull();
  });
});
