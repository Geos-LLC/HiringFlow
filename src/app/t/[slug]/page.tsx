'use client'

import { useParams, useSearchParams } from 'next/navigation'
import { TrainingViewer } from '@/components/TrainingViewer'

export default function TrainingPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  return (
    <TrainingViewer
      slug={params.slug as string}
      token={searchParams.get('token')}
      preview={searchParams.get('preview')}
      previewSectionId={searchParams.get('section')}
      variant="standalone"
    />
  )
}
