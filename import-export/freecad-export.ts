import JSZip from 'jszip';

export type FreeCadTriangleMesh = {
  positions: number[];
  label?: string;
};

export type FreeCadWebExport = {
  data: Blob;
  solidCount: number;
  triangleCount: number;
};

type Point3 = { x: number; y: number; z: number };
type Triangle = [number, number, number];
type Edge = { a: number; b: number; length: number; curveIndex: number };

const SHAPE_TOLERANCE = 1e-7;

function finitePoint(positions: number[], offset: number): Point3 | null {
  const x = Number(positions[offset]);
  const y = Number(positions[offset + 1]);
  const z = Number(positions[offset + 2]);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function pointKey(point: Point3): string {
  const scale = 1e5;
  return `${Math.round(point.x * scale)}:${Math.round(point.y * scale)}:${Math.round(point.z * scale)}`;
}

function formatNumber(value: number): string {
  const normalized = Math.abs(value) < 5e-15 ? 0 : value;
  return normalized.toFixed(17);
}

function vector(a: Point3, b: Point3): Point3 {
  return { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
}

function cross(a: Point3, b: Point3): Point3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function length(v: Point3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function normalize(v: Point3): Point3 {
  const magnitude = length(v);
  if (!(magnitude > 1e-12)) throw new Error('The FreeCAD solid contains a degenerate edge or face.');
  return { x: v.x / magnitude, y: v.y / magnitude, z: v.z / magnitude };
}

function formatPoint(point: Point3): string {
  return `${formatNumber(point.x)} ${formatNumber(point.y)} ${formatNumber(point.z)}`;
}

function prepareMesh(mesh: FreeCadTriangleMesh): { vertices: Point3[]; triangles: Triangle[] } {
  if (!Array.isArray(mesh.positions) || mesh.positions.length < 9 || mesh.positions.length % 9 !== 0) {
    throw new Error('FreeCAD export requires complete triangle data.');
  }

  const vertices: Point3[] = [];
  const vertexIndexes = new Map<string, number>();
  const triangles: Triangle[] = [];
  for (let offset = 0; offset < mesh.positions.length; offset += 9) {
    const triangle: number[] = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const point = finitePoint(mesh.positions, offset + corner * 3);
      if (!point) throw new Error('The FreeCAD solid contains a non-finite coordinate.');
      const key = pointKey(point);
      let index = vertexIndexes.get(key);
      if (index === undefined) {
        index = vertices.length;
        vertexIndexes.set(key, index);
        vertices.push(point);
      }
      triangle.push(index);
    }
    if (triangle[0] === triangle[1] || triangle[1] === triangle[2] || triangle[2] === triangle[0]) continue;
    triangles.push(triangle as Triangle);
  }

  if (triangles.length < 4) throw new Error('A FreeCAD solid must contain at least four non-degenerate triangles.');
  return { vertices, triangles };
}

/**
 * Serialize a closed triangular shell as an OpenCASCADE BREP. FreeCAD stores
 * Part::Feature shapes in this text representation inside its FCStd ZIP file.
 */
export function createOpenCascadeBrep(mesh: FreeCadTriangleMesh): string {
  const { vertices, triangles } = prepareMesh(mesh);
  const edges: Edge[] = [];
  const edgeIndexes = new Map<string, number>();
  const triangleEdges: Array<Array<{ index: number; forward: boolean }>> = [];
  const edgeUseCounts: number[] = [];

  for (const [a, b, c] of triangles) {
    const directedEdges: Array<[number, number]> = [[a, b], [b, c], [c, a]];
    const references: Array<{ index: number; forward: boolean }> = [];
    for (const [from, to] of directedEdges) {
      const key = `${Math.min(from, to)}:${Math.max(from, to)}`;
      let index = edgeIndexes.get(key);
      if (index === undefined) {
        index = edges.length;
        const magnitude = length(vector(vertices[from], vertices[to]));
        if (!(magnitude > 1e-12)) throw new Error('The FreeCAD solid contains a zero-length edge.');
        edgeIndexes.set(key, index);
        edges.push({ a: from, b: to, length: magnitude, curveIndex: index + 1 });
        edgeUseCounts.push(0);
      }
      const edge = edges[index];
      references.push({ index, forward: edge.a === from && edge.b === to });
      edgeUseCounts[index] += 1;
    }
    triangleEdges.push(references);
  }

  const openEdgeCount = edgeUseCounts.filter((count) => count !== 2).length;
  if (openEdgeCount > 0) {
    throw new Error(`The generated lens is not a closed manifold (${openEdgeCount} unmatched edges).`);
  }

  const surfaces = triangles.map(([a, b, c]) => {
    const origin = vertices[a];
    const xAxis = normalize(vector(origin, vertices[b]));
    const normal = normalize(cross(vector(origin, vertices[b]), vector(origin, vertices[c])));
    const yAxis = normalize(cross(normal, xAxis));
    return { origin, normal, xAxis, yAxis };
  });

  const shapeCount = vertices.length + edges.length + triangles.length * 2 + 2;
  const vertexShapeId = (index: number) => shapeCount - index;
  const edgeShapeId = (index: number) => shapeCount - vertices.length - index;
  const wireShapeId = (index: number) => shapeCount - vertices.length - edges.length - index * 2;
  const faceShapeId = (index: number) => wireShapeId(index) - 1;

  const lines: string[] = [
    'CASCADE Topology V1, (c) Matra-Datavision',
    'Locations 1',
    '1',
    '1.000000000000000 0.000000000000000 0.000000000000000 0.000000000000000 ',
    '0.000000000000000 1.000000000000000 0.000000000000000 0.000000000000000 ',
    '0.000000000000000 0.000000000000000 1.000000000000000 0.000000000000000 ',
    'Curve2ds 0',
    `Curves ${edges.length}`,
  ];

  edges.forEach((edge) => {
    const direction = normalize(vector(vertices[edge.a], vertices[edge.b]));
    lines.push(`1 ${formatPoint(vertices[edge.a])} ${formatPoint(direction)} `);
  });
  lines.push('Polygon3D 0', 'PolygonOnTriangulations 0', `Surfaces ${surfaces.length}`);
  surfaces.forEach((surface) => {
    lines.push(`1 ${formatPoint(surface.origin)} ${formatPoint(surface.normal)} ${formatPoint(surface.xAxis)} ${formatPoint(surface.yAxis)} `);
  });
  lines.push('Triangulations 0', '', `TShapes ${shapeCount}`);

  vertices.forEach((point) => {
    lines.push(
      'Ve',
      formatNumber(SHAPE_TOLERANCE),
      formatPoint(point),
      '0 0',
      '',
      '0101101',
      '*',
    );
  });

  edges.forEach((edge) => {
    lines.push(
      'Ed',
      ` ${formatNumber(SHAPE_TOLERANCE)} 1 1 0`,
      `1  ${edge.curveIndex} 0 ${formatNumber(0)} ${formatNumber(edge.length)}`,
      '0',
      '',
      '0101000',
      `+${vertexShapeId(edge.a)} 0 -${vertexShapeId(edge.b)} 0 *`,
    );
  });

  triangles.forEach((_, index) => {
    const edgeReferences = triangleEdges[index]
      .map((edge) => `${edge.forward ? '+' : '-'}${edgeShapeId(edge.index)} 0`)
      .join(' ');
    lines.push(
      'Wi',
      '',
      '0101100',
      `${edgeReferences} *`,
      'Fa',
      `0  ${formatNumber(SHAPE_TOLERANCE)} ${index + 1} 0`,
      '',
      '0101000',
      `+${wireShapeId(index)} 0 *`,
    );
  });

  const faces = triangles.map((_, index) => `+${faceShapeId(index)} 0`).join(' ');
  lines.push(
    'Sh',
    '',
    '0101100',
    `${faces} *`,
    'So',
    '',
    '1100000',
    '+2 0 *',
    '',
    '+1 1 ',
  );
  return `${lines.join('\n')}\n`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function documentXml(meshes: FreeCadTriangleMesh[], documentLabel: string): string {
  const createdAt = new Date().toISOString();
  const objectNames = meshes.map((_, index) => `LensSolid_${String(index + 1).padStart(3, '0')}`);
  const dependencies = objectNames.map((name) => `        <ObjectDeps Name="${name}" Count="0"/>`).join('\n');
  const objects = objectNames.map((name, index) => `        <Object type="Part::Feature" name="${name}" id="${1000 + index}" />`).join('\n');
  const objectData = objectNames.map((name, index) => `        <Object name="${name}">
            <Properties Count="7" TransientCount="1">
                <_Property name="_ElementMapVersion" type="App::PropertyString" status="234881024"/>
                <Property name="ExpressionEngine" type="App::PropertyExpressionEngine" status="67108864"><ExpressionEngine count="0"></ExpressionEngine></Property>
                <Property name="Label" type="App::PropertyString" status="134217728"><String value="${escapeXml(meshes[index].label || `Lens Solid ${String(index + 1).padStart(3, '0')}`)}"/></Property>
                <Property name="Label2" type="App::PropertyString" status="67108992"><String value=""/></Property>
                <Property name="Placement" type="App::PropertyPlacement" status="8388608"><PropertyPlacement Px="0" Py="0" Pz="0" Q0="0" Q1="0" Q2="0" Q3="1" A="0" Ox="0" Oy="0" Oz="1"/></Property>
                <Property name="Shape" type="Part::PropertyPartShape"><Part file="${name}.Shape.brp"/><ElementMap/></Property>
                <Property name="Source" type="App::PropertyString" group="CoOpt" status="2097152"><String value="co-opt web export"/></Property>
                <Property name="Visibility" type="App::PropertyBool" status="648"><Bool value="true"/></Property>
            </Properties>
        </Object>`).join('\n');

  return `<?xml version='1.0' encoding='utf-8'?>
<!-- FreeCAD document generated locally by co-opt web export. -->
<Document SchemaVersion="4" ProgramVersion="0.21R33771" FileVersion="1">
    <StringHasher saveall="0" threshold="0" count="0"></StringHasher>
    <Properties Count="8">
        <Property name="Comment" type="App::PropertyString"><String value="Optical solids exported by co-opt"/></Property>
        <Property name="Company" type="App::PropertyString"><String value=""/></Property>
        <Property name="CreatedBy" type="App::PropertyString"><String value="co-opt"/></Property>
        <Property name="CreationDate" type="App::PropertyString" status="16777217"><String value="${createdAt}"/></Property>
        <Property name="Label" type="App::PropertyString" status="16777217"><String value="${escapeXml(documentLabel)}"/></Property>
        <Property name="LastModifiedDate" type="App::PropertyString" status="16777217"><String value="${createdAt}"/></Property>
        <Property name="License" type="App::PropertyString"><String value="All rights reserved"/></Property>
        <Property name="Uid" type="App::PropertyUUID" status="16777217"><Uuid value="00000000-0000-4000-8000-000000000001"/></Property>
    </Properties>
    <Objects Count="${objectNames.length}" Dependencies="${objectNames.length}">
${dependencies}
${objects}
    </Objects>
    <ObjectData Count="${objectNames.length}">
${objectData}
    </ObjectData>
</Document>
`;
}

export async function generateFreeCadDocument(
  meshes: FreeCadTriangleMesh[],
  documentLabel = 'co-opt-render',
): Promise<FreeCadWebExport> {
  if (!Array.isArray(meshes) || meshes.length === 0) {
    throw new Error('No closed lens solids are available for FreeCAD export.');
  }

  const zip = new JSZip();
  zip.file('Document.xml', documentXml(meshes, documentLabel));
  meshes.forEach((mesh, index) => {
    const name = `LensSolid_${String(index + 1).padStart(3, '0')}.Shape.brp`;
    zip.file(name, createOpenCascadeBrep(mesh));
  });
  const data = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return {
    data,
    solidCount: meshes.length,
    triangleCount: meshes.reduce((sum, mesh) => sum + Math.floor(mesh.positions.length / 9), 0),
  };
}

export function downloadFreeCadDocument(data: Blob, filename = 'co-opt-render.FCStd'): void {
  const ensuredName = /\.fcstd$/i.test(filename) ? filename : `${filename}.FCStd`;
  const url = URL.createObjectURL(data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = ensuredName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
