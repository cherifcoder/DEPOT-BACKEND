import type { Role, User, UserRole } from '@prisma/client';

export interface PublicUser {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  roles: Role[];
  lastLoginAt: Date | null;
  createdAt: Date;
}

type UserWithRoles = User & { roles: (UserRole | Role)[] };

function toRole(entry: UserRole | Role): Role {
  return typeof entry === 'string' ? entry : entry.role;
}

export function serializeUser(user: UserWithRoles): PublicUser {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    roles: user.roles.map(toRole),
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}
