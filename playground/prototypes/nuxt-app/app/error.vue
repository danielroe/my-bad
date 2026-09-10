<script setup lang="ts">
defineProps<{ error: { statusCode?: number, message?: string } }>()
const route = useRoute()
</script>

<template>
  <main style="max-width: 640px; margin: 80px auto; padding: 24px; font: 15px/1.6 system-ui">
    <h1>{{ error.statusCode === 404 ? 'Employee not found' : 'The directory could not be loaded' }}</h1>
    <p>{{ error.message }}</p>
    <button style="font: inherit; padding: 8px 12px" @click="clearError({ redirect: `/?case=healthy&run=${route.query.run || ''}` })">Back to employees</button>
  </main>
</template>
