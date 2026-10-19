import type {
  ArchitectureLensResult,
  DataSchemaModel,
  DetectedSchemaModel,
  SchemaField,
  SchemaRelationship,
} from './types.ts';

export interface DataSchemaAnalyzerInput {
  files: Record<string, string>; // path -> content
}

/**
 * Detects supported SQL schemas, ORM models, validation schemas, and typed data models.
 * Shows real field relationships and references, handling malformed schemas gracefully.
 */
export function analyzeDataSchemas(
  input: DataSchemaAnalyzerInput
): ArchitectureLensResult<DataSchemaModel> {
  const models: DetectedSchemaModel[] = [];
  const diagnostics: string[] = [];
  let malformedSchemasCount = 0;

  for (const [filePath, content] of Object.entries(input.files)) {
    // 1. SQL CREATE TABLE schemas:
    // CREATE TABLE [IF NOT EXISTS] table_name ( col1 type PRIMARY KEY, col2 type REFERENCES other(id) )
    const sqlTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_"`]+)\s*\(([\s\S]*?)\);/gi;
    let sqlMatch: RegExpExecArray | null;

    while ((sqlMatch = sqlTableRegex.exec(content)) !== null) {
      const rawName = sqlMatch[1].replace(/[`"']/g, '').trim();
      const body = sqlMatch[2];
      const startLine = content.slice(0, sqlMatch.index).split('\n').length;
      const endLine = startLine + body.split('\n').length;

      try {
        const fields: SchemaField[] = [];
        const colLines = body.split(',\n').map((l) => l.trim()).filter(Boolean);

        for (const colDef of colLines) {
          // Check for table-level FOREIGN KEY (x) REFERENCES other(y)
          const fkMatch = colDef.match(/FOREIGN\s+KEY\s*\(([A-Za-z0-9_]+)\)\s*REFERENCES\s+([A-Za-z0-9_]+)\s*\(([A-Za-z0-9_]+)\)/i);
          if (fkMatch) {
            const fName = fkMatch[1];
            const refModel = fkMatch[2];
            const refField = fkMatch[3];
            const existing = fields.find((f) => f.name === fName);
            if (existing) {
              existing.isForeign = true;
              existing.referencesModel = refModel;
              existing.referencesField = refField;
            } else {
              fields.push({
                name: fName,
                type: 'FOREIGN_KEY',
                isForeign: true,
                referencesModel: refModel,
                referencesField: refField,
              });
            }
            continue;
          }

          const parts = colDef.split(/\s+/).filter(Boolean);
          if (parts.length >= 2) {
            const colName = parts[0].replace(/[`"']/g, '');
            if (/^(?:PRIMARY|FOREIGN|CONSTRAINT|UNIQUE|CHECK)$/i.test(colName)) continue;
            const colType = parts[1].toUpperCase();
            const isPrimary = /PRIMARY\s+KEY/i.test(colDef);
            const refMatch = colDef.match(/REFERENCES\s+([A-Za-z0-9_]+)\s*\(([A-Za-z0-9_]+)\)/i);

            fields.push({
              name: colName,
              type: colType,
              isPrimary,
              isForeign: Boolean(refMatch),
              referencesModel: refMatch ? refMatch[1] : undefined,
              referencesField: refMatch ? refMatch[2] : undefined,
              isNullable: !/NOT\s+NULL/i.test(colDef),
            });
          }
        }

        if (fields.length > 0) {
          models.push({
            id: `sql-${rawName}`,
            name: rawName,
            kind: 'sql_table',
            filePath,
            lineRange: { startLine, endLine },
            fields,
            rawDefinition: sqlMatch[0].slice(0, 300),
          });
        }
      } catch (err) {
        malformedSchemasCount++;
        diagnostics.push(`Malformed SQL table schema in ${filePath}:${startLine}: ${String(err)}`);
      }
    }

    // 2. Prisma Models: model Task { id String @id, ... }
    const prismaModelRegex = /model\s+([A-Za-z0-9_]+)\s*\{([^}]+)\}/g;
    let prismaMatch: RegExpExecArray | null;
    while ((prismaMatch = prismaModelRegex.exec(content)) !== null) {
      const name = prismaMatch[1];
      const body = prismaMatch[2];
      const startLine = content.slice(0, prismaMatch.index).split('\n').length;
      const endLine = startLine + body.split('\n').length;

      try {
        const fields: SchemaField[] = [];
        const fLines = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));

        for (const line of fLines) {
          const parts = line.split(/\s+/);
          if (parts.length >= 2) {
            const fName = parts[0];
            const fType = parts[1];
            const isPrimary = line.includes('@id');
            const relMatch = line.match(/@relation\([^)]*references:\s*\[([^\]]+)\]/);
            fields.push({
              name: fName,
              type: fType,
              isPrimary,
              isForeign: Boolean(relMatch),
              referencesModel: fType.replace(/[?[\]]/g, ''),
              referencesField: relMatch ? relMatch[1].trim() : undefined,
            });
          }
        }

        if (fields.length > 0) {
          models.push({
            id: `prisma-${name}`,
            name,
            kind: 'orm_model',
            filePath,
            lineRange: { startLine, endLine },
            fields,
            rawDefinition: prismaMatch[0].slice(0, 300),
          });
        }
      } catch (err) {
        malformedSchemasCount++;
        diagnostics.push(`Malformed Prisma model in ${filePath}:${startLine}: ${String(err)}`);
      }
    }

    // 3. Zod / Joi Validation Schemas: const TaskSchema = z.object({ ... })
    const zodRegex = /(?:const|let)\s+([A-Za-z0-9_$]+(?:Schema|Model|Validator))\s*=\s*(?:z|Joi)\.object\s*\(\s*\{([^}]+)\}\s*\)/g;
    let zodMatch: RegExpExecArray | null;
    while ((zodMatch = zodRegex.exec(content)) !== null) {
      const name = zodMatch[1];
      const body = zodMatch[2];
      const startLine = content.slice(0, zodMatch.index).split('\n').length;
      const endLine = startLine + body.split('\n').length;

      try {
        const fields: SchemaField[] = [];
        const fLines = body.split(',').map((l) => l.trim()).filter(Boolean);

        for (const line of fLines) {
          const [fName, fType] = line.split(':').map((s) => s.trim());
          if (fName && fType) {
            fields.push({
              name: fName,
              type: fType.slice(0, 30),
              isNullable: fType.includes('nullable') || fType.includes('optional'),
            });
          }
        }

        if (fields.length > 0) {
          models.push({
            id: `val-${name}`,
            name,
            kind: 'validation_schema',
            filePath,
            lineRange: { startLine, endLine },
            fields,
            rawDefinition: zodMatch[0].slice(0, 300),
          });
        }
      } catch (err) {
        malformedSchemasCount++;
        diagnostics.push(`Malformed validation schema in ${filePath}:${startLine}: ${String(err)}`);
      }
    }

    // 4. Typed Data Models (TypeScript Interfaces): export interface Task { id: string; ... }
    const interfaceRegex = /(?:export\s+)?interface\s+([A-Za-z0-9_$]+)\s*\{([^}]+)\}/g;
    let ifaceMatch: RegExpExecArray | null;
    while ((ifaceMatch = interfaceRegex.exec(content)) !== null) {
      const name = ifaceMatch[1];
      // Skip generic UI props interfaces like FooProps
      if (/Props$|State$|Options$|Context$|Config$/i.test(name)) continue;

      const body = ifaceMatch[2];
      const startLine = content.slice(0, ifaceMatch.index).split('\n').length;
      const endLine = startLine + body.split('\n').length;

      try {
        const fields: SchemaField[] = [];
        const fLines = body.split(/[;\n]/).map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));

        for (const line of fLines) {
          const colonIdx = line.indexOf(':');
          if (colonIdx > 0) {
            const fNameRaw = line.slice(0, colonIdx).trim();
            const fTypeRaw = line.slice(colonIdx + 1).trim();
            const isNullable = fNameRaw.endsWith('?');
            const fName = fNameRaw.replace('?', '');
            fields.push({
              name: fName,
              type: fTypeRaw.slice(0, 40),
              isNullable,
            });
          }
        }

        if (fields.length > 0) {
          models.push({
            id: `iface-${name}`,
            name,
            kind: 'typed_interface',
            filePath,
            lineRange: { startLine, endLine },
            fields,
            rawDefinition: ifaceMatch[0].slice(0, 300),
          });
        }
      } catch (err) {
        malformedSchemasCount++;
        diagnostics.push(`Malformed TypeScript interface in ${filePath}:${startLine}: ${String(err)}`);
      }
    }

    // 5. Pydantic Models: class ItemCreate(BaseModel): ...
    const pydanticRegex = /class\s+([A-Za-z0-9_]+)\s*\(\s*(?:[A-Za-z0-9_.]*BaseModel[A-Za-z0-9_.]*)\s*\)\s*:([\s\S]*?)(?=\nclass\s|\ndef\s|\n[A-Za-z0-9_]+\s*=|$)/g;
    let pydanticMatch: RegExpExecArray | null;
    while ((pydanticMatch = pydanticRegex.exec(content)) !== null) {
      const name = pydanticMatch[1];
      const body = pydanticMatch[2];
      const startLine = content.slice(0, pydanticMatch.index).split('\n').length;
      const endLine = startLine + body.split('\n').length;

      try {
        const fields: SchemaField[] = [];
        const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes(':'));

        for (const line of lines) {
          const colonIdx = line.indexOf(':');
          if (colonIdx > 0) {
            const fName = line.slice(0, colonIdx).trim();
            const rest = line.slice(colonIdx + 1).trim();
            const eqIdx = rest.indexOf('=');
            const fType = (eqIdx > 0 ? rest.slice(0, eqIdx) : rest).trim();
            fields.push({
              name: fName,
              type: fType.slice(0, 30),
              isNullable: fType.toLowerCase().includes('optional') || line.includes('default=None'),
            });
          }
        }

        if (fields.length > 0) {
          models.push({
            id: `pydantic-${name}`,
            name,
            kind: 'validation_schema',
            filePath,
            lineRange: { startLine, endLine },
            fields,
            rawDefinition: pydanticMatch[0].slice(0, 300),
          });
        }
      } catch (err) {
        malformedSchemasCount++;
        diagnostics.push(`Malformed Pydantic model in ${filePath}:${startLine}: ${String(err)}`);
      }
    }
  }

  // 5. Connect real field relationships and references across models
  const relationships: SchemaRelationship[] = [];
  const modelNameMap = new Map<string, DetectedSchemaModel>();
  for (const m of models) {
    modelNameMap.set(m.name.toLowerCase(), m);
  }

  for (const model of models) {
    for (const field of model.fields) {
      // Direct foreign key or referencesModel property
      if (field.referencesModel) {
        const targetModel = modelNameMap.get(field.referencesModel.toLowerCase());
        relationships.push({
          id: `rel-${model.name}-${field.name}-${field.referencesModel}`,
          sourceModel: model.name,
          targetModel: targetModel?.name || field.referencesModel,
          sourceField: field.name,
          targetField: field.referencesField || 'id',
          kind: 'foreign_key',
          evidence: `Field "${model.name}.${field.name}" references "${field.referencesModel}.${field.referencesField || 'id'}"`,
        });
      } else {
        // Naming convention match: userId -> references User.id
        if (field.name.endsWith('Id') && field.name.length > 2) {
          const potentialModelName = field.name.slice(0, -2);
          const target = modelNameMap.get(potentialModelName.toLowerCase()) ||
            modelNameMap.get(`${potentialModelName.toLowerCase()}s`);
          if (target && target.name.toLowerCase() !== model.name.toLowerCase()) {
            relationships.push({
              id: `rel-${model.name}-${field.name}-${target.name}`,
              sourceModel: model.name,
              targetModel: target.name,
              sourceField: field.name,
              targetField: 'id',
              kind: 'type_reference',
              evidence: `Identifier "${field.name}" matches primary key of model "${target.name}"`,
            });
          }
        }
      }
    }
  }

  const hasSufficientEvidence = models.length > 0;

  return {
    viewMode: 'data_schema',
    title: 'Data & Schema Model View',
    hasSufficientEvidence,
    reasonIfUnsupported: hasSufficientEvidence
      ? undefined
      : 'No SQL tables, ORM models, validation schemas, or typed entity models detected in inspected code.',
    model: hasSufficientEvidence
      ? {
          models,
          relationships,
          malformedSchemasCount,
          diagnostics,
        }
      : null,
    stats: {
      modelsCount: models.length,
      relationshipsCount: relationships.length,
      malformedSchemasCount,
    },
  };
}
