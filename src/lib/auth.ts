import { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { prisma } from './prisma'
import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
          include: {
            memberships: {
              include: { workspace: true },
              orderBy: { joinedAt: 'asc' },
              take: 1,
            },
          },
        })

        if (!user) {
          return null
        }

        const isPasswordValid = await bcrypt.compare(
          credentials.password,
          user.passwordHash
        )

        if (!isPasswordValid) {
          return null
        }

        const membership = user.memberships[0]

        return {
          id: user.id,
          email: user.email,
          name: user.name || user.email,
          isSuperAdmin: user.isSuperAdmin,
          workspaceId: membership?.workspaceId || '',
          workspaceName: membership?.workspace.name || '',
          role: membership?.role || 'member',
        }
      },
    }),
  ],
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/login',
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.isSuperAdmin = (user as any).isSuperAdmin
        token.workspaceId = (user as any).workspaceId
        token.workspaceName = (user as any).workspaceName
        token.role = (user as any).role
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string
        ;(session.user as any).isSuperAdmin = token.isSuperAdmin as boolean
        ;(session.user as any).workspaceId = token.workspaceId as string
        ;(session.user as any).workspaceName = token.workspaceName as string
        ;(session.user as any).role = token.role as string
      }
      return session
    },
  },
}

/**
 * Get authenticated workspace session for business admin API routes.
 */
export async function getWorkspaceSession(): Promise<{
  userId: string
  workspaceId: string
  role: string
  isSuperAdmin: boolean
} | null> {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return null
  const workspaceId = (session.user as any).workspaceId as string | undefined
  if (!workspaceId) return null
  return {
    userId: session.user.id,
    workspaceId,
    role: (session.user as any).role || 'member',
    isSuperAdmin: (session.user as any).isSuperAdmin || false,
  }
}

/**
 * Get super admin session. Returns null if not a super admin.
 */
export async function getSuperAdminSession(): Promise<{ userId: string } | null> {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return null
  if (!(session.user as any).isSuperAdmin) return null
  return { userId: session.user.id }
}

export function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export function forbidden(message?: string) {
  return NextResponse.json({ error: 'Forbidden', message }, { status: 403 })
}

/**
 * Role hierarchy: owner > admin > member. `owner` and `admin` share the
 * same set of privileged capabilities in this codebase (both can invite,
 * change roles, remove members, manage billing). `owner` gets one extra
 * capability that `admin` does not: deleting the workspace itself.
 *
 * Super admins bypass every role check.
 */
export function isAdminOrOwner(role: string, isSuperAdmin = false): boolean {
  return isSuperAdmin || role === 'owner' || role === 'admin'
}

export function isOwner(role: string, isSuperAdmin = false): boolean {
  return isSuperAdmin || role === 'owner'
}
