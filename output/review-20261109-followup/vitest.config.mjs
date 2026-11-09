export default { test: {
  environment: 'happy-dom',
  environmentOptions: { happyDOM: { url: 'https://review.invalid/' } },
  include: ['output/review-20261109-followup/*.test.{ts,tsx}'],
  fileParallelism: false,
} };
