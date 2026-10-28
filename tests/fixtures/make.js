// Builds small made-up .xsq files that mimic the structure xLights writes.
function seq({ strand = '', nodes = '', effects = [], palettes = 1, headFx = '' } = {}) {
  const db = effects.map((e) => `    <Effect>${e}</Effect>`).join('\n');
  const pal = Array.from({ length: palettes }, () => '    <ColorPalette>C_BUTTON_Palette1=#FFFFFF,C_CHECKBOX_Palette1=1</ColorPalette>').join('\n');
  let tilt;
  if (!strand && !nodes) tilt = '    <Element type="model" name="MH Tilt">\n      <EffectLayer />\n    </Element>';
  else tilt = `    <Element type="model" name="MH Tilt">\n      <EffectLayer />\n      <Strand index="0">\n${strand}${nodes}      </Strand>\n    </Element>`;
  return `<?xml version="1.0"?>
<xsequence BaseChannel="0" ChanCtrlBasic="0" ChanCtrlColor="0" FixedPointTiming="1" ModelBlending="true">
  <head>
    <version>2026.10</version>
    <sequenceTiming>25 ms</sequenceTiming>
    <sequenceDuration>180.010</sequenceDuration>
  </head>
  <ColorPalettes>
${pal}
  </ColorPalettes>
  <EffectDB>
${db}
  </EffectDB>
  <DisplayElements>
    <Element collapsed="false" type="model" name="MH Tilt" visible="true" />
  </DisplayElements>
  <ElementEffects>
    <Element type="model" name="YPS-MovingHead-1">
      <EffectLayer>
${headFx}      </EffectLayer>
    </Element>
${tilt}
    <Element type="model" name="Mega Tree">
      <EffectLayer />
    </Element>
  </ElementEffects>
</xsequence>
`;
}
module.exports = { seq };
