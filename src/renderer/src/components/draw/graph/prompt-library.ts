export interface DrawPromptPreset {
  id: string
  title: string
  category: 'product' | 'portrait' | 'scene' | 'editing'
  prompt: string
}

export const DRAW_PROMPT_PRESETS: DrawPromptPreset[] = [
  {
    id: 'product-studio',
    title: 'Studio product hero',
    category: 'product',
    prompt:
      'Create a premium studio product photograph with a clear silhouette, restrained reflections, realistic material detail, and generous negative space for layout.'
  },
  {
    id: 'product-lifestyle',
    title: 'Lifestyle product scene',
    category: 'product',
    prompt:
      'Place the product in a believable everyday setting used by its intended audience. Preserve accurate proportions and brand details while using natural light and subtle depth of field.'
  },
  {
    id: 'portrait-editorial',
    title: 'Editorial portrait',
    category: 'portrait',
    prompt:
      'Create an editorial portrait with natural skin texture, intentional wardrobe styling, controlled directional light, and an uncluttered background. Avoid excessive retouching.'
  },
  {
    id: 'portrait-environmental',
    title: 'Environmental portrait',
    category: 'portrait',
    prompt:
      'Show the subject naturally engaged in a relevant environment. Use contextual details as evidence of their work or interests while keeping the face and gesture clearly readable.'
  },
  {
    id: 'scene-cinematic',
    title: 'Cinematic establishing shot',
    category: 'scene',
    prompt:
      'Create a cinematic establishing shot with layered foreground, midground, and background, motivated lighting, coherent scale, and a clear visual story without adding text.'
  },
  {
    id: 'scene-isometric',
    title: 'Isometric system scene',
    category: 'scene',
    prompt:
      'Create a clean isometric scene that explains the system through spatial grouping, consistent perspective, limited colors, readable object hierarchy, and no decorative clutter.'
  },
  {
    id: 'edit-cleanup',
    title: 'Remove distractions',
    category: 'editing',
    prompt:
      'Remove the selected distractions and reconstruct the background naturally. Preserve the original lighting, perspective, texture, and all unselected subjects.'
  },
  {
    id: 'edit-background',
    title: 'Replace background',
    category: 'editing',
    prompt:
      'Replace only the background with the described environment. Preserve the foreground subject, edges, pose, proportions, lighting direction, and identifying details.'
  },
  {
    id: 'edit-outpaint',
    title: 'Extend composition',
    category: 'editing',
    prompt:
      'Extend the composition into the transparent border. Continue lines, lighting, depth, and texture seamlessly while preserving every pixel in the protected original region.'
  },
  {
    id: 'edit-angle',
    title: 'Alternate camera angle',
    category: 'editing',
    prompt:
      'Render the same subject from the requested camera angle. Preserve identity, materials, colors, scale, and environment continuity; change only the viewpoint and resulting occlusion.'
  }
]
