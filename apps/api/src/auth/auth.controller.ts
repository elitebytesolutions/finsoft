import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Patch,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UsePipes,
} from '@nestjs/common'
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger'
import type { Request, Response } from 'express'
import { HashingQueueFullError, ThrottleUnavailableError } from '@finsoft/auth'
import { logCommittedBusinessEvent } from '@finsoft/observability'
import { AuthenticatedOnly } from '../common/authenticated-only.decorator'
import { Public } from '../common/tenant.guard'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { AuthService } from './auth.service'
import { clearRefreshCookie, hasCsrfHeader, readRefreshCookie, setRefreshCookie } from './cookie'
import { LoginSchema, type LoginDto } from './dto/login.dto'
import { UpdateMeSchema, type UpdateMeDto } from './dto/update-me.dto'
import { clientIp, deviceFingerprint, ipPrefix } from './request-context'

/*
 * The auth HTTP contract. This shape is FIXED for M1: the web lane
 * (m1-web) builds its API client against exactly these endpoints, bodies and
 * error shapes.
 */

const INVALID_CREDENTIALS = {
  statusCode: 401,
  error: 'invalid_credentials',
  message: 'Invalid tenant, email or password.',
} as const

function throttled(retryAfterSeconds: number, res: Response): never {
  res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))))
  throw new HttpException(
    { statusCode: 429, error: 'rate_limited', message: 'Too many attempts. Try again later.' },
    429,
  )
}

/**
 * B4: ADR-0023 §5 layer 4 (global) never blocks — it alerts. This is the
 * alert: a business event, logged after the fact, never in the request's
 * own success/failure path. `alertedLayers` is empty on every ordinary
 * request, so this is a no-op except during an actual volume spike.
 */
function logThrottleAlerts(alertedLayers: readonly string[]): void {
  for (const key of alertedLayers) {
    logCommittedBusinessEvent({
      event: 'THROTTLE_LAYER_ALERTED',
      detail: { layer: key },
    })
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(LoginSchema))
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = clientIp(req)

    let result
    try {
      result = await this.auth.login({
        tenantCode: body.tenantCode,
        email: body.email,
        password: body.password,
        ip,
        ipPrefix: ipPrefix(ip),
        deviceId: deviceFingerprint(req),
        userAgent: req.headers['user-agent'] ?? null,
      })
    } catch (error) {
      if (error instanceof ThrottleUnavailableError) {
        throw new ServiceUnavailableException({
          statusCode: 503,
          error: 'rate_limiter_unavailable',
          message: 'Try again shortly.',
        })
      }
      if (error instanceof HashingQueueFullError) {
        throw new ServiceUnavailableException({
          statusCode: 503,
          error: 'busy',
          message: 'Try again shortly.',
        })
      }
      throw error
    }

    logThrottleAlerts(result.alertedLayers)

    if (result.outcome === 'throttled') throttled(result.retryAfterSeconds, res)
    if (result.outcome === 'failed') throw new UnauthorizedException(INVALID_CREDENTIALS)

    setRefreshCookie(res, result.refreshToken, result.refreshTokenExpiresAt)

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: {
        id: result.user.id,
        fullName: result.user.fullName,
        email: result.user.email,
      },
      tenant: { id: result.tenant.id, code: result.tenant.code, name: result.tenant.name },
    }
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!hasCsrfHeader(req)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'csrf_header_required',
        message: 'X-Requested-With: finsoft is required.',
      })
    }

    const presented = readRefreshCookie(req)
    if (!presented) throw new UnauthorizedException(INVALID_CREDENTIALS)

    const ip = clientIp(req)

    let result
    try {
      result = await this.auth.refresh({
        presentedRefreshToken: presented,
        ipPrefix: ipPrefix(ip),
        ip,
        deviceId: deviceFingerprint(req),
      })
    } catch (error) {
      if (error instanceof ThrottleUnavailableError) {
        throw new ServiceUnavailableException({
          statusCode: 503,
          error: 'rate_limiter_unavailable',
          message: 'Try again shortly.',
        })
      }
      throw error
    }

    if (result.outcome === 'throttled') throttled(result.retryAfterSeconds, res)
    if (result.outcome === 'failed') {
      // Reuse or expiry: the spent/unknown cookie must not linger client-side.
      clearRefreshCookie(res)

      if (result.reason === 'reused' && result.reuse) {
        // Ids only — never the presented hash or any credential-shaped
        // value. The audit sink itself is still a no-op (M1-D); this is the
        // seam the coordinator asked for so wiring a real sink later needs
        // no change here.
        logCommittedBusinessEvent({
          event: 'REFRESH_REUSE_DETECTED',
          entityType: 'session',
          entityId: result.reuse.sessionId,
          detail: { tenantId: result.reuse.tenantId, familyId: result.reuse.familyId },
        })
      }

      throw new UnauthorizedException(INVALID_CREDENTIALS)
    }

    setRefreshCookie(res, result.refreshToken, result.refreshTokenExpiresAt)

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: { id: result.user.id, fullName: result.user.fullName, email: result.user.email },
      tenant: { id: result.tenant.id, code: result.tenant.code, name: result.tenant.name },
    }
  }

  @AuthenticatedOnly()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    if (!hasCsrfHeader(req)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'csrf_header_required',
        message: 'X-Requested-With: finsoft is required.',
      })
    }

    // The guard is not @Public() on this route, so req.auth is set or the
    // request never reached here.
    const auth = req.auth
    if (!auth) throw new UnauthorizedException(INVALID_CREDENTIALS)

    await this.auth.logout(auth, clientIp(req))
    clearRefreshCookie(res)
  }

  @AuthenticatedOnly()
  @Get('me')
  async me(@Req() req: Request) {
    const auth = req.auth
    if (!auth) throw new UnauthorizedException(INVALID_CREDENTIALS)

    const profile = await this.auth.me(auth)
    if (!profile) throw new UnauthorizedException(INVALID_CREDENTIALS)
    return profile
  }

  /**
   * M1-X, W1-006 exit criterion 1: the minimal authorised write "tenant A
   * can read and update its own record" needs. Updates only fullName —
   * audited by updateOwnFullName itself (packages/database/src/auth/
   * session.ts), inside the same transaction as the write.
   *
   * M1-X, Council DB C3: `body.version` is the optimistic-concurrency token
   * GET /api/auth/me returned. A mismatch is reported as 409 with NO audit
   * row written — an update that did not happen is not an event.
   */
  @AuthenticatedOnly()
  @Patch('me')
  @UsePipes(new ZodValidationPipe(UpdateMeSchema))
  @ApiOperation({
    summary: "Update the caller's own display name.",
    description:
      'Optimistic concurrency: version must match the value GET /api/auth/me returned, or the ' +
      'request 409s with the current version and writes nothing (not even an audit row).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['fullName', 'version'],
      properties: {
        fullName: { type: 'string', minLength: 1, maxLength: 200 },
        version: { type: 'integer', minimum: 0 },
      },
    },
  })
  @ApiOkResponse({ description: 'Updated profile, including the new version.' })
  @ApiBadRequestResponse({ description: 'fullName or version failed validation.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked credentials.' })
  @ApiConflictResponse({ description: 'version did not match the row’s current version.' })
  async updateMe(@Body() body: UpdateMeDto, @Req() req: Request) {
    const auth = req.auth
    if (!auth) throw new UnauthorizedException(INVALID_CREDENTIALS)

    const outcome = await this.auth.updateMe(auth.userId, body.fullName, body.version)

    if (outcome.outcome === 'not_found') throw new UnauthorizedException(INVALID_CREDENTIALS)

    if (outcome.outcome === 'version_conflict') {
      throw new ConflictException({
        statusCode: 409,
        error: 'version_conflict',
        message: 'The record has changed since you last read it.',
        currentVersion: outcome.currentVersion,
      })
    }

    return outcome.profile
  }

  @Public()
  @Get('jwks')
  async jwks() {
    return this.auth.jwks()
  }
}
