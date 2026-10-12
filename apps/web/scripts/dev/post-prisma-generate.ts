import { ALL_ENUMS } from "../../lib/types/enums";
import path from "path";
import fs from "fs";
import { createRequire } from "module";

function generateStaticJsInjection(): string {
  let injection = "\n// --- SQLite / D1 Explicit Static Enum Augmentation ---\n";
  injection += "const _injectedEnums = " + JSON.stringify(ALL_ENUMS) + ";\n";
  injection += "if (typeof module !== 'undefined' && module.exports) {\n";
  injection += "  Object.assign(module.exports, _injectedEnums);\n";
  injection += "  module.exports.$Enums = Object.assign(module.exports.$Enums || {}, _injectedEnums);\n";
  injection += "}\n";
  injection += "if (typeof exports !== 'undefined') {\n";
  injection += "  Object.assign(exports, _injectedEnums);\n";
  injection += "  exports.$Enums = Object.assign(exports.$Enums || {}, _injectedEnums);\n";
  injection += "}\n";

  // Emit explicit static assignments for cjs-module-lexer / ESM named export discovery
  for (const enumName of Object.keys(ALL_ENUMS)) {
    injection += `module.exports.${enumName} = exports.${enumName} = _injectedEnums.${enumName};\n`;
  }

  // NOTE: Do NOT patch Prisma.TransactionIsolationLevel here. The SQLite engine
  // only supports Serializable; mapping RepeatableRead/ReadUncommitted to
  // unsupported values makes the engine start `BEGIN IMMEDIATE`, fail, and never
  // roll back, which poisons the connection. Application code must only use
  // Prisma.TransactionIsolationLevel.Serializable (D1 ignores isolation levels).
  return injection;
}

function stripExistingInjection(content: string): string {
  const marker = "// --- SQLite / D1";
  const idx = content.indexOf(marker);
  if (idx !== -1) {
    return content.substring(0, idx).trimEnd() + "\n";
  }
  return content;
}

export function augmentPrismaClientWithEnums() {
  const req = createRequire(__filename);
  let clientIndex: string;
  try {
    clientIndex = req.resolve("@prisma/client");
  } catch {
    return;
  }

  const prismaClientDir = path.dirname(clientIndex);
  let dotPrismaDir: string | null = null;
  try {
    const dotPrismaDefault = req.resolve(".prisma/client/default", {
      paths: [clientIndex],
    });
    dotPrismaDir = path.dirname(dotPrismaDefault);
  } catch {
    try {
      const clientReq = createRequire(clientIndex);
      const dotPrismaDefault = clientReq.resolve(".prisma/client/default");
      dotPrismaDir = path.dirname(dotPrismaDefault);
    } catch {
      // skip
    }
  }

  // 1. Runtime JS Augmentation across all entrypoints (including browser bundles)
  const targetFiles: string[] = [
    path.join(prismaClientDir, "index.js"),
    path.join(prismaClientDir, "default.js"),
    path.join(prismaClientDir, "index-browser.js"),
  ];

  if (dotPrismaDir) {
    targetFiles.push(
      path.join(dotPrismaDir, "index.js"),
      path.join(dotPrismaDir, "default.js"),
      path.join(dotPrismaDir, "index-browser.js")
    );
  }

  const jsInjection = generateStaticJsInjection();

  for (const tf of targetFiles) {
    if (fs.existsSync(tf)) {
      const orig = fs.readFileSync(tf, "utf8");
      const stripped = stripExistingInjection(orig);
      fs.writeFileSync(tf, stripped + jsInjection);
      console.log("Augmented enum runtime exports in:", tf);
    }
  }

  // 2. TypeScript Type Definition Augmentation in index.d.ts
  if (dotPrismaDir) {
    const dotPrismaIndexDts = path.join(dotPrismaDir, "index.d.ts");
    if (fs.existsSync(dotPrismaIndexDts)) {
      let dts = fs.readFileSync(dotPrismaIndexDts, "utf8");

      // Build enum declarations
      let enumDts = "\n  export namespace $Enums {\n";
      for (const [name, obj] of Object.entries(ALL_ENUMS)) {
        const vals = Object.keys(obj as any)
          .map((v) => JSON.stringify(v))
          .join(" | ");
        enumDts += `    export const ${name}: {\n`;
        for (const k of Object.keys(obj as any)) {
          enumDts += `      readonly ${k}: "${k}";\n`;
        }
        enumDts += `    };\n`;
        enumDts += `    export type ${name} = ${vals};\n`;
      }
      enumDts += "  }\n";

      if (!dts.includes("export namespace $Enums")) {
        dts = dts.replace(
          "export namespace Prisma {",
          "export namespace Prisma {\n" + enumDts
        );
      }

      // Add top-level enum exports if missing
      if (!dts.includes("// Top-level SQLite Enum Exports")) {
        let topLevelDts = "\n// Top-level SQLite Enum Exports\n";
        topLevelDts += "export import $Enums = Prisma.$Enums;\n";
        for (const name of Object.keys(ALL_ENUMS)) {
          topLevelDts += `export type ${name} = Prisma.$Enums.${name};\n`;
          topLevelDts += `export const ${name}: typeof Prisma.$Enums.${name};\n`;
        }
        dts += topLevelDts;
      }

      // Extract model field mappings from static json file (NEVER git diff)
      const mappingsPath = path.join(__dirname, "enum-field-mappings.json");
      if (fs.existsSync(mappingsPath)) {
        const mappings: Array<{
          model: string;
          field: string;
          enumName: string;
        }> = JSON.parse(fs.readFileSync(mappingsPath, "utf8"));

        // Replace model scalar types in $ModelPayload
        for (const { model, field, enumName } of mappings) {
          const payloadHeader = "export type $" + model + "Payload<";
          const headerIdx = dts.indexOf(payloadHeader);
          if (headerIdx !== -1) {
            const scalarsIdx = dts.indexOf(
              "scalars: $Extensions.GetPayloadResult<{",
              headerIdx
            );
            if (scalarsIdx !== -1) {
              const scalarsEnd = dts.indexOf(
                '}, ExtArgs["result"]',
                scalarsIdx
              );
              if (scalarsEnd !== -1) {
                const beforeScalars = dts.slice(0, scalarsIdx);
                let scalarsBlock = dts.slice(scalarsIdx, scalarsEnd);
                const afterScalars = dts.slice(scalarsEnd);

                // Replace scalar type
                scalarsBlock = scalarsBlock.replace(
                  new RegExp(
                    "([ \t]+" + field + ": )string(\\s*\\|\\s*null)?([ \t]*\r?\n)"
                  ),
                  (m, prefix, isNullable, suffix) => {
                    return `${prefix}Prisma.$Enums.${enumName}${
                      isNullable ? " | null" : ""
                    }${suffix}`;
                  }
                );

                dts = beforeScalars + scalarsBlock + afterScalars;
              }
            }
          }
        }
      }

      // Allow skipDuplicates: boolean in index.d.ts (handled by runtime createMany extension)
      dts = dts.replace(/skipDuplicates\?: never;/g, "skipDuplicates?: boolean;");

      // Add programId_partnerId alias to ProgramApplicationEventWhereUniqueInput (handled by runtime query extension)
      dts = dts.replace(
        "export type ProgramApplicationEventWhereUniqueInput = {",
        "export type ProgramApplicationEventWhereUniqueInput = {\n    programId_partnerId?: Prisma.ProgramApplicationEventPartnerIdProgramIdCompoundUniqueInput;\n"
      );

      fs.writeFileSync(dotPrismaIndexDts, dts);
      console.log("Augmented enum types in:", dotPrismaIndexDts);
    }
  }
}

augmentPrismaClientWithEnums();
