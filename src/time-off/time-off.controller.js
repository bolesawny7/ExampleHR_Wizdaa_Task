import {
  Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req,
  UseGuards, ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard, Roles } from '../auth/auth.guard.js';
import { NotFoundError } from '../common/errors.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { CreateRequestDto, RejectRequestDto } from './dto/create-request.dto.js';
import { TimeOffService } from './time-off.service.js';

const validateCreate = new ValidationPipe({
  expectedType: CreateRequestDto,
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validateReject = new ValidationPipe({
  expectedType: RejectRequestDto,
  whitelist: true,
  transform: true,
});

@Controller()
@UseGuards(JwtAuthGuard)
export class TimeOffController {
  constructor(
    @Inject(TimeOffService) timeOff,
    @Inject(IdempotencyService) idempotency,
  ) {
    this._timeOff = timeOff;
    this._idem = idempotency;
  }

  @Post('/me/requests')
  @Roles('employee', 'manager', 'admin')
  @HttpCode(201)
  create(
    @Req() req,
    @Body(validateCreate) body,
    @Headers('idempotency-key') idemKey,
  ) {
    const ep = 'POST /me/requests';
    const cached = this._idem.lookup(idemKey, ep, req.user.sub);
    if (cached) return cached.response;

    const created = this._timeOff.createRequest({
      actor: req.user,
      input: body,
    });
    this._idem.store(idemKey, ep, req.user.sub, 201, created);
    return created;
  }

  @Get('/me/requests')
  @Roles('employee', 'manager', 'admin')
  listMine(@Req() req) {
    return this._timeOff.listForEmployee(req.user.sub);
  }

  @Get('/me/requests/:id')
  @Roles('employee', 'manager', 'admin')
  getMine(@Req() req, @Param('id') id) {
    const r = this._timeOff.getById(id);
    if (r.employeeId !== req.user.sub && !req.user.roles.includes('admin')) {
      // Do not leak existence of other employees' requests to the caller.
      throw new NotFoundError('Request', id);
    }
    return r;
  }

  @Post('/me/requests/:id/cancel')
  @Roles('employee', 'manager', 'admin')
  cancel(@Req() req, @Param('id') id) {
    return this._timeOff.cancel({ actor: req.user, requestId: id });
  }

  @Get('/manager/requests')
  @Roles('manager', 'admin')
  listForManager(@Req() req) {
    return this._timeOff.listForManager(req.user.sub);
  }

  @Post('/manager/requests/:id/approve')
  @Roles('manager', 'admin')
  approve(@Req() req, @Param('id') id) {
    return this._timeOff.approve({ actor: req.user, requestId: id });
  }

  @Post('/manager/requests/:id/reject')
  @Roles('manager', 'admin')
  reject(@Req() req, @Param('id') id, @Body(validateReject) body) {
    return this._timeOff.reject({
      actor: req.user,
      requestId: id,
      reason: body?.reason ?? null,
    });
  }
}
