import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsISO8601, IsNumber, IsOptional, IsString,
  MaxLength, Min, ValidateNested,
} from 'class-validator';

/** One row in an HCM balance batch. */
export class HcmBalanceEntryDto {
  @IsString() @MaxLength(64) employeeId;
  @IsString() @MaxLength(64) locationId;
  @IsString() @MaxLength(32) leaveType;
  @IsNumber() @Min(0) balance;
  @IsOptional() @IsISO8601({ strict: true }) asOf;
}

/** POST /hcm/webhooks/batch body. */
export class HcmBatchDto {
  @IsOptional() @IsString() @MaxLength(128) batchId;
  @IsOptional() @IsISO8601({ strict: true }) asOf;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => HcmBalanceEntryDto)
  balances;
}

/** POST /hcm/webhooks/balance body. */
export class HcmBalanceDto {
  @IsString() @MaxLength(64) employeeId;
  @IsString() @MaxLength(64) locationId;
  @IsString() @MaxLength(32) leaveType;
  @IsNumber() @Min(0) balance;
  @IsOptional() @IsISO8601({ strict: true }) asOf;
}
