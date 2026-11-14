// Malhas detalhadas sobre o relevo REAL (DEM HiRISE da Cratera Gale), em níveis:
//  - L1: 12 x 12 km fixa em volta do ponto de referência, um vértice a cada 30 m (dado de 8 m);
//  - L2: 1,5 x 1,5 km que acompanha o astronauta, um vértice a cada 3 m (dado de 2 m perto do ponto).
// A malha mais grossa "abre um buraco" (discard no shader) onde a mais fina está, então não há
// cintilação entre elas. A cor vem dos mosaicos reais (CTX + HiRISE) e dos remendos HiRISE do mundo.
import * as THREE from 'three';
import { enhanceTerrainMaterial, makeHoleUniform, composeRegionImage } from './terrain.js';

class DetailMesh {
  constructor(world, scene, { size, seg }) {
    this.world = world;
    this.size = size;
    this.seg = seg;
    this.cell = size / seg;
    this.hole = makeHoleUniform();
    this.geometry = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
    this.material = new THREE.MeshStandardMaterial({ color: 0x9a7a62, roughness: 0.92, metalness: 0.02 });
    enhanceTerrainMaterial(this.material, world.uniforms, this.hole);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.visible = false;
    this.base = this.geometry.attributes.position.array.slice(); // grade local centrada em (0, 0)
    this.texRegion = null;
    scene.add(this.mesh);
  }

  /** Recalcula a malha centrada em (cx, cz), alinhada à grade (sem "nadar" ao recentrar). */
  build(cx, cz) {
    this.cx = Math.round(cx / this.cell) * this.cell;
    this.cz = Math.round(cz / this.cell) * this.cell;
    const pos = this.geometry.attributes.position;
    const uv = this.geometry.attributes.uv;
    const r = this.texRegion;
    for (let i = 0; i < pos.count; i++) {
      const x = this.base[i * 3] + this.cx;
      const z = this.base[i * 3 + 2] + this.cz;
      pos.setXYZ(i, x, this.world.heightAt(x, z), z);
      if (r) uv.setXY(i, (x - r.minX) / r.size, 1 - (z - r.minZ) / r.size);
    }
    pos.needsUpdate = true;
    uv.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
    this.mesh.visible = true;
  }

  /** Retângulo coberto, encolhido em `inset` células (sobreposição que esconde a costura). */
  rect(inset = 2) {
    const h = this.size / 2 - inset * this.cell;
    return new THREE.Vector4(this.cx - h, this.cz - h, this.cx + h, this.cz + h);
  }

  setTexture(tex, region) {
    this.texRegion = region;
    this.material.map = tex;
    this.material.color.set(0xffffff);
    this.material.needsUpdate = true;
    if (this.cx !== undefined) this.build(this.cx, this.cz);
  }
}

export class DetailTerrain {
  constructor(world, scene) {
    this.world = world;
    this.l1 = new DetailMesh(world, scene, { size: 12000, seg: 400 });
    this.l2 = new DetailMesh(world, scene, { size: 1500, seg: 500 });
    this.recenterDist = 350;
  }

  /** center: ponto de referência (mundo); pos: posição do astronauta. */
  init(center, pos) {
    this.center = center;
    this.l1.build(center.x, center.z);
    this.l2.build(pos.x, pos.z);
    this._holes();
    // Cor: CTX + HiRISE reais para os 12 km (em segundo plano; até lá a cor vem dos remendos)
    const half = this.l1.size / 2;
    composeRegionImage(this.world, center.x, center.z, half, { size: 2048, hirise: 'map3d', maxTiles: 120 }).then(
      (img) => {
        const tex = new THREE.CanvasTexture(img.canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        const region = { minX: center.x - half, minZ: center.z - half, size: 2 * half };
        this.l1.setTexture(tex, region);
        this.l2.setTexture(tex, region);
        this.sources = img.sources;
      }
    );
  }

  _holes() {
    this.world.chunkHole.value.copy(this.l1.rect());
    this.l1.hole.value.copy(this.l2.rect());
  }

  update(pos) {
    let changed = false;
    // L1 também acompanha, de longe, para a L2 ficar sempre dentro dela (um buraco só no bloco)
    if (Math.max(Math.abs(pos.x - this.l1.cx), Math.abs(pos.z - this.l1.cz)) > this.l1.size / 2 - 1500) {
      this.l1.build(pos.x, pos.z);
      changed = true;
    }
    if (Math.hypot(pos.x - this.l2.cx, pos.z - this.l2.cz) > this.recenterDist) {
      this.l2.build(pos.x, pos.z);
      changed = true;
    }
    if (changed) this._holes();
  }

  /** Depois de mudar a escala vertical. */
  rebuild() {
    this.l1.build(this.l1.cx, this.l1.cz);
    this.l2.build(this.l2.cx, this.l2.cz);
  }
}
